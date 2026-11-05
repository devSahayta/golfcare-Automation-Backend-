// src/controllers/offerController.js
//
// Phase 5 — read-only Offers log for staff. One row per quoted price the
// agent (or an owner, step 9 = owner-approved) has ever made — the
// step-based negotiation ladder, expiry, and supersession are all already
// on the Offer row itself (Phase 2/3), so this is a straight paginated/
// filterable list, newest first, with Customer and Variant joined in via
// Offer's real Prisma relations (no manual batch-fetch needed here, unlike
// resolveVariantPricingInputs's FK-only joins elsewhere).

const { prisma } = require("../lib/prisma");

async function listOffers(req, res) {
  try {
    let page = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);
    page = Number.isFinite(page) && page > 0 ? page : 1;
    limit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 25;

    const where = {};
    if (req.query.customerId) where.customerId = req.query.customerId;
    if (req.query.variantId) where.variantId = req.query.variantId;
    if (req.query.status) where.status = req.query.status;
    if (req.query.conversationId)
      where.conversationId = req.query.conversationId;

    const [total, rows] = await Promise.all([
      prisma.offer.count({ where }),
      prisma.offer.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          Customer: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              waPhone: true,
              memberCode: true,
              tier: true,
            },
          },
          Variant: {
            select: {
              id: true,
              title: true,
              sku: true,
              shopifyVariantId: true,
            },
          },
        },
      }),
    ]);

    res.json({
      data: rows,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("listOffers failed:", err);
    res.status(500).json({ error: "Failed to load offers" });
  }
}

module.exports = { listOffers };
