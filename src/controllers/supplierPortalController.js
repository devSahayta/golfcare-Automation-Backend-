// controllers/supplierPortalController.js
//
// Public (token-authed, see middleware/supplierPortalAuth.js) API for the
// supplier stock-check portal page — a supplier's alternative to replying
// over WhatsApp chat, for when their pending list is too large to handle
// conversationally (see supplierCheckinService.js's header). Drives the
// exact same confirmation logic the Supplier Agent uses, just without the
// chat-specific item-count cap (this is a scrollable page, not a WhatsApp
// message) and without exposing pricing fields (v1 is stock status only).
const { prisma } = require("../lib/prisma");
const { getOpenCheckin, applyConfirmation, confirmAllPendingItems } = require("../services/supplierCheckinService");

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
    res.json({ supplierName: supplier.name, items: itemsWithStatus });
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
  const { supplierProductId, status, leadTimeDays } = req.body;

  if (!supplierProductId) return res.status(400).json({ error: "supplierProductId is required" });
  if (status !== "IN_STOCK" && status !== "OUT_OF_STOCK") {
    return res.status(400).json({ error: "status must be IN_STOCK or OUT_OF_STOCK" });
  }

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
    });
    res.json(result);
  } catch (err) {
    console.error("confirmItem error:", err);
    res.status(500).json({ error: "Failed to confirm item" });
  }
}

module.exports = { getPortalItems, confirmAll, confirmItem };
