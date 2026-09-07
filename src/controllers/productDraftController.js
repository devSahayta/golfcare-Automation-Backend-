// controllers/productDraftController.js
//
// Module 5.2 approval flow. Deliberately split GET (safe, renders a
// confirmation page, no mutation) from POST (the actual decision) —
// email security scanners and some clients prefetch links to scan them,
// which would silently auto-approve a draft nobody looked at if the
// email link itself performed the mutation. A human still only taps
// once; a bot GETting the page does nothing.
//
// The approvalToken itself is the auth — these routes are intentionally
// public (matches ProductDraft's schema: single-use, expiring token, no
// StaffUser session tied to it). Validity (exists, still PENDING, not
// expired) is re-checked on the POST independently of what the GET
// rendered, since the two requests can be minutes apart.

const axios = require("axios");
const { prisma } = require("../lib/prisma");
const { env } = require("../config/env");
const { getValidAccessToken } = require("../services/shopifyAuth");
const { publishProduct } = require("../services/shopifyProductCreate");
const { handleProductUpsert } = require("./shopifyWebhookController");

const SHOPIFY_API_VERSION = "2024-10";

// Same fakeReqRes pattern shopifyProductImport.js already uses to reuse
// handleProductUpsert outside of an actual webhook delivery.
function fakeReqRes(product) {
  return { req: { body: product }, res: { status: () => ({ send: () => {} }) } };
}

// Syncs the just-approved product into our own Product/Variant tables
// immediately, rather than waiting on Shopify's products/update webhook —
// this session already saw webhook timing/delivery-target mismatches
// (local dev vs deployed instance) cause real drift, and the
// SupplierProduct link this function creates needs the local ids to
// exist right now, not whenever the webhook happens to land. Also where a
// brand-new product's margin/GST/cost-price finally get a home — they've
// been sitting in ProductDraft.rawPayload since create_product_draft
// couldn't create this link itself (no local Product/Variant existed yet).
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
  const localVariant = await prisma.variant.findFirst({ where: { productId: localProduct.id } });
  if (!localVariant) return;

  const alreadyLinked = await prisma.supplierProduct.findFirst({
    where: { supplierId: draft.supplierId, variantId: localVariant.id },
  });
  if (alreadyLinked) return;

  const p = draft.rawPayload || {};
  await prisma.supplierProduct.create({
    data: {
      supplierId: draft.supplierId,
      productId: localProduct.id,
      variantId: localVariant.id,
      supplierSku: p.sku || null,
      costPrice: p.costPrice ?? null,
      marginPercent: p.marginPercent ?? null,
      gstPercent: p.gstPercent ?? null,
      isPrimary: true,
      lastConfirmedStatus: "IN_STOCK",
      lastConfirmedAt: new Date(),
    },
  });
}

function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function page(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Golf Care — Product Draft</title>
<style>body{font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#111}
img{max-width:100%;border-radius:8px} form{display:inline-block;margin-right:8px}
button{padding:10px 20px;border:none;border-radius:6px;font-size:15px;cursor:pointer}
.approve{background:#16a34a;color:#fff} .reject{background:#dc2626;color:#fff}</style>
</head><body>${bodyHtml}</body></html>`;
}

async function loadPendingDraft(token) {
  const draft = await prisma.productDraft.findUnique({ where: { approvalToken: token } });
  if (!draft) return { error: "not_found" };
  if (draft.approvalStatus !== "PENDING") return { error: "already_decided", draft };
  if (draft.tokenExpiresAt < new Date()) return { error: "expired", draft };
  return { draft };
}

async function showDraft(req, res) {
  const { token } = req.params;
  const { draft, error } = await loadPendingDraft(token);

  if (error === "not_found") {
    return res.status(404).send(page("<h2>Not found</h2><p>This approval link is invalid.</p>"));
  }
  if (error === "already_decided") {
    return res.send(
      page(`<h2>Already ${escapeHtml(draft.approvalStatus.toLowerCase())}</h2><p>This draft was already decided on.</p>`),
    );
  }
  if (error === "expired") {
    return res.send(page("<h2>Link expired</h2><p>This approval link has expired.</p>"));
  }

  const p = draft.rawPayload || {};
  const sourceLabel =
    draft.sourceType === "WEB_SCRAPED"
      ? "Sourced from a web search — unverified, please check before approving"
      : `Provided directly by ${p.supplierName || "the supplier"}`;

  const detailBits = [
    p.brand,
    p.sku ? `SKU ${p.sku}` : null,
    ...(p.variantOptions || []).map((o) => `${o.name}: ${o.value}`),
  ].filter(Boolean);

  res.send(
    page(`
      <h2>New product pending approval</h2>
      <p><strong>${escapeHtml(p.title)}</strong></p>
      <p>&#8377;${escapeHtml(p.price)}${p.category ? ` &middot; ${escapeHtml(p.category)}` : ""}</p>
      ${detailBits.length ? `<p style="color:#444;">${escapeHtml(detailBits.join(" · "))}</p>` : ""}
      ${p.imageUrl ? `<img src="${escapeHtml(p.imageUrl)}" alt="">` : ""}
      ${p.specs ? `<p>${escapeHtml(p.specs)}</p>` : ""}
      <p style="color:#666;font-size:13px;">${escapeHtml(sourceLabel)}</p>
      ${p.sourceNotes ? `<p style="color:#666;font-size:13px;">${escapeHtml(p.sourceNotes)}</p>` : ""}
      <form method="POST" action="/api/product-drafts/${encodeURIComponent(token)}/approve">
        <button class="approve" type="submit">Approve &amp; publish</button>
      </form>
      <form method="POST" action="/api/product-drafts/${encodeURIComponent(token)}/reject">
        <button class="reject" type="submit">Reject</button>
      </form>
    `),
  );
}

async function approveDraft(req, res) {
  const { token } = req.params;
  const { draft, error } = await loadPendingDraft(token);
  if (error) {
    return res.status(error === "not_found" ? 404 : 409).send(page(`<h2>Can't approve</h2><p>${error}</p>`));
  }

  try {
    if (draft.shopifyDraftProductId) {
      await publishProduct(draft.shopifyDraftProductId);
    }
    await prisma.productDraft.update({
      where: { id: draft.id },
      data: { approvalStatus: "APPROVED", approvedVia: "EMAIL", decidedAt: new Date() },
    });

    try {
      await linkSupplierToApprovedProduct(draft);
    } catch (linkErr) {
      // The product itself is live either way — a missed supplier link
      // means margin/GST/cost-price won't be on file yet, worth knowing
      // about but not worth failing the whole approval over.
      console.error(
        "[productDraftController] linkSupplierToApprovedProduct failed:",
        linkErr.response?.data || linkErr.message,
      );
    }

    res.send(page("<h2>Approved</h2><p>The product is now live on Shopify.</p>"));
  } catch (err) {
    console.error("[productDraftController] approve failed:", err.response?.data || err.message);
    res.status(500).send(page("<h2>Something went wrong</h2><p>Publishing to Shopify failed — nothing was changed. Try again shortly.</p>"));
  }
}

async function rejectDraft(req, res) {
  const { token } = req.params;
  const { draft, error } = await loadPendingDraft(token);
  if (error) {
    return res.status(error === "not_found" ? 404 : 409).send(page(`<h2>Can't reject</h2><p>${error}</p>`));
  }

  // Left as an unpublished Shopify draft rather than deleted — reversible,
  // a human can still revisit it directly in Shopify if this was a mistake.
  await prisma.productDraft.update({
    where: { id: draft.id },
    data: { approvalStatus: "REJECTED", approvedVia: "EMAIL", decidedAt: new Date() },
  });
  res.send(page("<h2>Rejected</h2><p>The draft was left unpublished on Shopify.</p>"));
}

module.exports = { showDraft, approveDraft, rejectDraft };
