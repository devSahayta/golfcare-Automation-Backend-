// controllers/supplierPortalController.js
//
// Public (token-authed, see middleware/supplierPortalAuth.js) API for the
// supplier stock-check portal page — a supplier's alternative to replying
// over WhatsApp chat, for when their pending list is too large to handle
// conversationally (see supplierCheckinService.js's header). Drives the
// exact same confirmation logic the Supplier Agent uses, just without the
// chat-specific item-count cap (this is a scrollable page, not a WhatsApp
// message) and without exposing pricing fields (v1 is stock status only).
const crypto = require("crypto");
const { prisma } = require("../lib/prisma");
const { env } = require("../config/env");
const { getOpenCheckin, applyConfirmation, confirmAllPendingItems } = require("../services/supplierCheckinService");
const { uploadSupplierImage, uploadNewProductImage } = require("../services/supabaseStorageService");
const { sendSupplierImageApprovalEmail, sendProductDraftApprovalEmail } = require("../services/emailService");
const { getInventoryLevel, updateInventoryItemCost } = require("../services/shopifyInventory");
const { createDraftProduct } = require("../services/shopifyProductCreate");
const { computeCostPrice } = require("../services/pricingCalculator");
const { findExistingPendingDraft, findExistingCatalogMatch } = require("../services/productCatalogMatch");

// GET /api/supplier-portal/:token/items
//
// Items already confirmed this check-in (per-item confirm, or a prior
// confirm-all) get their status attached so a page refresh/reopen shows
// what's already done instead of re-asking — the confirmation itself was
// always saved correctly (SupplierProduct.lastConfirmedStatus +
// check.rawReplies.confirmations, see recordConfirmationOnOpenCheck), this
// endpoint just wasn't surfacing it back to the page.
async function getPortalItems(req, res) {
  const supplier = req.supplier;

  try {
    const check = await getOpenCheckin({ supplierId: supplier.id });
    const items = Array.isArray(check?.items) ? check.items : [];
    const confirmations = Array.isArray(check?.rawReplies?.confirmations)
      ? check.rawReplies.confirmations
      : [];
    const statusBySupplierProductId = new Map(
      confirmations.map((c) => [c.supplierProductId, c.status]),
    );

    // Looked up fresh from Product rather than stored on the check at
    // dispatch time — means this works for checks already open before
    // this field existed, and always reflects the current Shopify image.
    const productIds = [...new Set(items.map((i) => i.productId).filter(Boolean))];
    const products = productIds.length
      ? await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, imageUrls: true },
        })
      : [];
    const imageUrlByProductId = new Map(products.map((p) => [p.id, p.imageUrls?.[0] ?? null]));

    const itemsWithStatus = items.map((item) => ({
      ...item,
      confirmedStatus: statusBySupplierProductId.get(item.supplierProductId) ?? null,
      imageUrl: imageUrlByProductId.get(item.productId) ?? null,
    }));
    res.json({ supplierName: supplier.name, brands: supplier.brands, items: itemsWithStatus });
  } catch (err) {
    console.error("getPortalItems error:", err);
    res.status(500).json({ error: "Failed to load pending items" });
  }
}

// POST /api/supplier-portal/:token/confirm-all — body: { status, leadTimeDays? }
async function confirmAll(req, res) {
  const supplier = req.supplier;
  const { status, leadTimeDays } = req.body;

  if (status !== "IN_STOCK" && status !== "OUT_OF_STOCK") {
    return res.status(400).json({ error: "status must be IN_STOCK or OUT_OF_STOCK" });
  }

  try {
    const result = await confirmAllPendingItems({ supplier, status, leadTimeDays: leadTimeDays ?? null });
    if (result.error) return res.status(409).json(result);
    res.json(result);
  } catch (err) {
    console.error("confirmAll error:", err);
    res.status(500).json({ error: "Failed to confirm items" });
  }
}

// POST /api/supplier-portal/:token/confirm-item — body: { supplierProductId, status, leadTimeDays? }
async function confirmItem(req, res) {
  const supplier = req.supplier;
  const { supplierProductId, status, leadTimeDays, quantity } = req.body;

  if (!supplierProductId) return res.status(400).json({ error: "supplierProductId is required" });
  if (status !== "IN_STOCK" && status !== "OUT_OF_STOCK") {
    return res.status(400).json({ error: "status must be IN_STOCK or OUT_OF_STOCK" });
  }
  // Supplier-typed real stock count — see shopifyInventory.js's
  // mapStatusToQuantity; only ever honored for IN_STOCK, left out/invalid
  // falls through to the existing default quantity exactly as before this
  // feature existed.
  const cleanQuantity =
    quantity != null && Number.isFinite(Number(quantity)) && Number(quantity) >= 0
      ? Number(quantity)
      : null;

  try {
    const supplierProduct = await prisma.supplierProduct.findFirst({
      where: { id: supplierProductId, supplierId: supplier.id },
    });
    if (!supplierProduct) return res.status(404).json({ error: "Item not found" });

    const result = await applyConfirmation({
      supplier,
      supplierProduct,
      status,
      leadTimeDays: leadTimeDays ?? null,
      mrp: null,
      marginPercent: null,
      gstPercent: null,
      quantity: cleanQuantity,
    });
    res.json(result);
  } catch (err) {
    console.error("confirmItem error:", err);
    res.status(500).json({ error: "Failed to confirm item" });
  }
}

// POST /api/supplier-portal/:token/items/:supplierProductId/image — multipart, field "image"
//
// Zero-images-only gate is enforced here, fresh from the DB — not trusted
// from what the page happened to show, since the page's own data could be
// stale by the time this request lands. Never touches Shopify directly:
// stages the file in Supabase, creates a PENDING SupplierImageSubmission,
// and emails staff for approval (see supplierImageSubmissionService.js /
// supplierImageApprovalController.js) — same "agent proposes, human
// decides" posture as ProductDraft.
async function uploadItemImage(req, res) {
  const supplier = req.supplier;
  const { supplierProductId } = req.params;

  if (!req.file) return res.status(400).json({ error: "image file is required" });

  try {
    const supplierProduct = await prisma.supplierProduct.findFirst({
      where: { id: supplierProductId, supplierId: supplier.id },
      include: { Product: true },
    });
    if (!supplierProduct) return res.status(404).json({ error: "Item not found" });

    const product = supplierProduct.Product;
    if (product.imageUrls.length > 0) {
      return res.status(409).json({ error: "product_already_has_image" });
    }

    const existingPending = await prisma.supplierImageSubmission.findFirst({
      where: { productId: product.id, status: "PENDING" },
    });
    if (existingPending) {
      return res.status(409).json({ error: "submission_already_pending" });
    }

    const imageUrl = await uploadSupplierImage(req.file.buffer, product.id, req.file.mimetype);

    const approvalToken = crypto.randomBytes(24).toString("hex");
    const tokenExpiresAt = new Date(
      Date.now() + env.supplierImageApprovalTokenExpiryDays * 24 * 60 * 60 * 1000,
    );

    await prisma.supplierImageSubmission.create({
      data: {
        productId: product.id,
        supplierId: supplier.id,
        imageUrl,
        approvalToken,
        tokenExpiresAt,
      },
    });

    try {
      await sendSupplierImageApprovalEmail({
        token: approvalToken,
        productTitle: product.title,
        imageUrl,
        supplierName: supplier.name,
      });
    } catch (emailErr) {
      // Submission is saved either way — staff can still find it via the
      // DB if the email itself failed to send (e.g. STAFF_APPROVAL_EMAIL
      // misconfigured). Don't fail the supplier's upload over it.
      console.error("uploadItemImage: approval email failed:", emailErr.message);
    }

    res.json({ status: "pending_review" });
  } catch (err) {
    console.error("uploadItemImage error:", err);
    res.status(500).json({ error: "Failed to upload image" });
  }
}

// GET /api/supplier-portal/:token/items/:supplierProductId/stock
//
// Purely informational — lets the page show a supplier the real current
// Shopify stock number before they confirm (see confirmItem's `quantity`
// param). Never a reason to block confirming: any lookup failure comes
// back as {available: null, tracked: null} rather than an error status.
async function getItemStock(req, res) {
  const supplier = req.supplier;
  const { supplierProductId } = req.params;

  const supplierProduct = await prisma.supplierProduct.findFirst({
    where: { id: supplierProductId, supplierId: supplier.id },
    include: { Variant: true },
  });
  if (!supplierProduct) return res.status(404).json({ error: "Item not found" });
  if (!supplierProduct.Variant) {
    return res.json({ available: null, tracked: null });
  }

  try {
    const level = await getInventoryLevel(supplierProduct.Variant.shopifyVariantId);
    res.json(level);
  } catch (err) {
    console.error("getItemStock error:", err.response?.data || err.message);
    res.json({ available: null, tracked: null });
  }
}

// POST /api/supplier-portal/:token/products — multipart, field "image" plus
// text fields: title, price, marginPercent, gstPercent, brand, category?,
// sku?, specs?, quantity?
//
// The portal's own equivalent of the WhatsApp chat's create_product_draft
// tool (supplierAgentTools.js) — same validation, same dedup/catalog-match
// checks (via services/productCatalogMatch.js, shared so the two paths
// can't drift apart), same ProductDraft/email-approval posture ("supplier
// proposes, staff decides"). marginPercent/gstPercent are required here
// too — these are the supplier's own commercial terms (the margin they
// give Golf Care off MRP, and the GST that applies to their product), not
// Golf Care's internal numbers, so it's reasonable to ask the supplier
// directly, same as the chat flow already does.
async function createNewProductDraft(req, res) {
  const supplier = req.supplier;
  const { title, price, marginPercent, gstPercent, brand, category, sku, specs, quantity } = req.body;

  if (!title || price == null || marginPercent == null || gstPercent == null || !brand) {
    return res.status(400).json({ error: "title, price, marginPercent, gstPercent, and brand are required" });
  }
  if (!req.file) return res.status(400).json({ error: "image file is required" });

  const cleanPrice = Number(price);
  const cleanMargin = Number(marginPercent);
  const cleanGst = Number(gstPercent);
  if (!Number.isFinite(cleanPrice) || !Number.isFinite(cleanMargin) || !Number.isFinite(cleanGst)) {
    return res.status(400).json({ error: "price, marginPercent, and gstPercent must be numbers" });
  }
  const cleanQuantity = quantity != null && Number.isFinite(Number(quantity)) ? Number(quantity) : null;

  // Same business rule as create_product_draft: a supplier should only
  // ever draft brands on their own allowed-brands list.
  const brandAllowed = supplier.brands.some((b) => b.toLowerCase() === String(brand).toLowerCase());
  if (!brandAllowed) {
    return res.status(409).json({
      error: "brand_not_allowed",
      message: `This supplier isn't set up to supply "${brand}" — it needs to be added to their account first.`,
    });
  }

  try {
    // Same dedup reasoning as create_product_draft's own call site — a
    // double-submit (slow network, impatient double-tap) must not create
    // a second Shopify product for something already pending review.
    const existingPending = await findExistingPendingDraft(supplier.id, title);
    if (existingPending) {
      return res.status(409).json({ error: "draft_already_exists" });
    }

    // This "new product" might not be new to Golf Care at all — check the
    // real global catalog before creating a duplicate Shopify product,
    // same branch create_product_draft already takes.
    const catalogMatch = await findExistingCatalogMatch({ title, sku, variantOptions: [] });
    if (catalogMatch?.variant) {
      let supplierProduct = await prisma.supplierProduct.findFirst({
        where: { supplierId: supplier.id, variantId: catalogMatch.variant.id },
      });
      if (!supplierProduct) {
        supplierProduct = await prisma.supplierProduct.create({
          data: {
            supplierId: supplier.id,
            productId: catalogMatch.product.id,
            variantId: catalogMatch.variant.id,
            supplierSku: sku || null,
            isPrimary: true,
          },
        });
      }
      const result = await applyConfirmation({
        supplier,
        supplierProduct,
        status: "IN_STOCK",
        leadTimeDays: null,
        mrp: cleanPrice,
        marginPercent: cleanMargin,
        gstPercent: cleanGst,
        quantity: cleanQuantity,
      });
      return res.json({
        productAlreadyExisted: true,
        matchedProductTitle: catalogMatch.product.title,
        ...result,
      });
    }

    const imageUrl = await uploadNewProductImage(req.file.buffer, supplier.id, req.file.mimetype);

    let shopifyResult;
    try {
      shopifyResult = await createDraftProduct({
        title,
        price: cleanPrice,
        category: category || undefined,
        specs: specs || undefined,
        brand,
        sku: sku || undefined,
        variantOptions: [],
        imageUrl,
        quantity: cleanQuantity,
      });
    } catch (err) {
      console.error("createNewProductDraft: Shopify creation failed:", err.response?.data || err.message);
      return res.status(500).json({ error: "shopify_creation_failed" });
    }

    const costPrice = computeCostPrice({ mrp: cleanPrice, marginPercent: cleanMargin, gstPercent: cleanGst });

    // Best-effort, same as create_product_draft's own cost-sync call.
    const costResult = await updateInventoryItemCost(shopifyResult.shopifyVariantId, costPrice);
    if (!costResult.ok) {
      console.error(
        `createNewProductDraft: Shopify cost sync failed for ${shopifyResult.shopifyProductId}:`,
        costResult.error,
      );
    }

    const approvalToken = crypto.randomBytes(24).toString("hex");
    const tokenExpiresAt = new Date(Date.now() + env.productDraftTokenExpiryDays * 24 * 60 * 60 * 1000);

    const draft = await prisma.productDraft.create({
      data: {
        shopifyDraftProductId: shopifyResult.shopifyProductId,
        supplierId: supplier.id,
        sourceType: "SUPPLIER_PROVIDED",
        rawPayload: {
          title,
          price: cleanPrice,
          category: category || null,
          specs: specs || null,
          brand,
          sku: sku || null,
          variantOptions: [],
          quantity: cleanQuantity,
          mrp: cleanPrice,
          marginPercent: cleanMargin,
          gstPercent: cleanGst,
          costPrice,
          imageUrl,
          sourceNotes: "Submitted directly by the supplier via the check-in portal's add-product form.",
          supplierName: supplier.name,
        },
        approvalToken,
        tokenExpiresAt,
      },
    });

    try {
      const emailResult = await sendProductDraftApprovalEmail({
        token: approvalToken,
        title,
        price: cleanPrice,
        category,
        specs,
        brand,
        sku,
        variantOptions: [],
        imageUrl,
        sourceType: "SUPPLIER_PROVIDED",
        supplierName: supplier.name,
      });
      await prisma.productDraft.update({
        where: { id: draft.id },
        data: { emailSentTo: emailResult.sentTo, emailSentAt: new Date() },
      });
    } catch (emailErr) {
      // The draft and the real Shopify product both already exist —
      // don't fail the supplier's submission over a notification problem.
      console.error("createNewProductDraft: approval email failed:", emailErr.message);
    }

    res.json({ status: "pending_review" });
  } catch (err) {
    console.error("createNewProductDraft error:", err);
    res.status(500).json({ error: "Failed to create product draft" });
  }
}

module.exports = { getPortalItems, confirmAll, confirmItem, uploadItemImage, getItemStock, createNewProductDraft };
