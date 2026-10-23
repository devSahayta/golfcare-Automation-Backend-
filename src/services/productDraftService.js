// src/services/productDraftService.js
//
// Module 5.2 — the one place that decides a ProductDraft is approved or
// rejected and, on approval, publishes it on Shopify. Called from both
// the emailed-link approval page (controllers/productDraftController.js,
// token-authenticated, no login needed) and the staff dashboard
// (controllers/productImportController.js, requireStaffAuth), so the two
// paths can never drift apart — same reasoning as Module 6's
// campaignTemplateService.js.
//
// Does NOT check ProductDraft.tokenExpiresAt — that's specific to the
// emailed link's own validity window and is checked there (see
// productDraftController.js's loadPendingDraft) before this is ever
// called; a logged-in staff member approving from the dashboard isn't
// using that token at all, so there's nothing to expire for that path.

const axios = require("axios");
const { prisma } = require("../lib/prisma");
const { env } = require("../config/env");
const { getValidAccessToken } = require("./shopifyAuth");
const { publishProduct, deleteProduct } = require("./shopifyProductCreate");
const { handleProductUpsert } = require("../controllers/shopifyWebhookController");

const SHOPIFY_API_VERSION = "2024-10";

// Same fakeReqRes pattern shopifyProductImport.js already uses to reuse
// handleProductUpsert outside of an actual webhook delivery.
function fakeReqRes(product) {
  return { req: { body: product }, res: { status: () => ({ send: () => {} }) } };
}

// Syncs the just-approved product into our own Product/Variant tables
// immediately, rather than waiting on Shopify's products/update webhook,
// and links the supplier (margin/GST/cost-price, which have been sitting
// in ProductDraft.rawPayload since create_product_draft/bulk-import
// couldn't create this link itself — no local Product/Variant existed
// yet). Loops every real variant (a bulk-import multi-variant draft, e.g.
// a belt in 4 colors, needs one SupplierProduct row per variant) — a
// plain one-by-one draft just has one to loop over.
async function linkSupplierToApprovedProduct(draft) {
  if (!draft.supplierId || !draft.shopifyDraftProductId) return;

  const accessToken = await getValidAccessToken();
  const client = axios.create({
    baseURL: `https://${env.shopify.shopDomain}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: { "X-Shopify-Access-Token": accessToken },
    timeout: 15000,
  });
  const res = await client.get(`/products/${draft.shopifyDraftProductId}.json`);
  const shopifyProduct = res.data.product;

  const { req, res: fakeRes } = fakeReqRes(shopifyProduct);
  await handleProductUpsert(req, fakeRes);

  const localProduct = await prisma.product.findUnique({
    where: { shopifyProductId: draft.shopifyDraftProductId },
  });
  if (!localProduct) return; // upsert failed silently somehow — nothing to link

  const localVariants = await prisma.variant.findMany({ where: { productId: localProduct.id } });
  if (localVariants.length === 0) return;

  const p = draft.rawPayload || {};
  const payloadVariants =
    Array.isArray(p.variants) && p.variants.length > 0
      ? p.variants
      : [{ sku: p.sku || null, value: null, mrp: p.price ?? null, costPrice: p.costPrice ?? null }];

  for (let i = 0; i < localVariants.length; i++) {
    const localVariant = localVariants[i];
    const alreadyLinked = await prisma.supplierProduct.findFirst({
      where: { supplierId: draft.supplierId, variantId: localVariant.id },
    });
    if (alreadyLinked) continue;

    const match =
      payloadVariants.find((v) => v.sku && localVariant.sku && v.sku === localVariant.sku) ||
      payloadVariants.find((v) => v.value && localVariant.optionValues?.option1 === v.value) ||
      payloadVariants[i] ||
      payloadVariants[0];

    await prisma.supplierProduct.create({
      data: {
        supplierId: draft.supplierId,
        productId: localProduct.id,
        variantId: localVariant.id,
        supplierSku: match.sku || localVariant.sku || null,
        costPrice: match.costPrice ?? null,
        marginPercent: p.marginPercent ?? null,
        gstPercent: p.gstPercent ?? null,
        isPrimary: i === 0,
        lastConfirmedStatus: "IN_STOCK",
        lastConfirmedAt: new Date(),
      },
    });
  }
}

// Throws if the draft isn't PENDING anymore, so a double-click or a
// stale link/UI state can't publish the same draft twice.
async function approveAndPublish(draftId, { approvedVia, decidedBy = null } = {}) {
  const draft = await prisma.productDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw Object.assign(new Error("not_found"), { status: 404 });
  if (draft.approvalStatus !== "PENDING") {
    throw Object.assign(new Error("already_decided"), { status: 409 });
  }

  if (draft.shopifyDraftProductId) {
    await publishProduct(draft.shopifyDraftProductId);
  }
  const updated = await prisma.productDraft.update({
    where: { id: draft.id },
    data: { approvalStatus: "APPROVED", approvedVia, decidedBy, decidedAt: new Date() },
  });

  try {
    await linkSupplierToApprovedProduct(updated);
  } catch (linkErr) {
    // The product itself is live either way — a missed supplier link
    // means margin/GST/cost-price won't be on file yet, worth knowing
    // about but not worth failing the whole approval over.
    console.error(
      "[productDraftService] linkSupplierToApprovedProduct failed:",
      linkErr.response?.data || linkErr.message,
    );
  }

  return updated;
}

async function reject(draftId, { approvedVia, decidedBy = null } = {}) {
  const draft = await prisma.productDraft.findUnique({ where: { id: draftId } });
  if (!draft) throw Object.assign(new Error("not_found"), { status: 404 });
  if (draft.approvalStatus !== "PENDING") {
    throw Object.assign(new Error("already_decided"), { status: 409 });
  }

  // Staff actively rejected this — remove the unpublished Shopify draft
  // rather than leaving it sitting in the store indefinitely.
  if (draft.shopifyDraftProductId) {
    try {
      await deleteProduct(draft.shopifyDraftProductId);
    } catch (err) {
      // Don't let a Shopify-side failure block the rejection itself —
      // worth knowing about, not worth failing the staff action over.
      console.error(
        "[productDraftService] deleteProduct failed:",
        err.response?.data || err.message,
      );
    }
  }

  return prisma.productDraft.update({
    where: { id: draft.id },
    data: { approvalStatus: "REJECTED", approvedVia, decidedBy, decidedAt: new Date() },
  });
}

module.exports = { approveAndPublish, reject };
