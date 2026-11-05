// src/controllers/escalationController.js
//
// Phase 5 — read-only Escalations feed for staff: every AuditLog row the
// agent's escalate_to_human tool has ever written (action =
// "escalated_to_human", entityType = "Conversation", entityId =
// conversation.id — see salesAgentTools.js), newest first, enriched with:
//   - the Customer, via a batch Conversation lookup (AuditLog itself has
//     no direct customerId column)
//   - the current Offer, when the escalation fired mid-negotiation —
//     afterState.offerContext = {variantId, currentOfferId}, set by the
//     agent at escalation time (null for a non-pricing escalation, e.g.
//     "can't confirm real stock")
//   - a FRESHLY recomputed floor/cost for that offer's variant, using the
//     live PricingConfig and SupplierProduct cost right now — not whatever
//     floorAtOffer was frozen to when the offer was made, since config or
//     cost can have changed since. floorAtOffer itself is still on the
//     Offer row if staff want the historical number instead.
//
// AuditLog, Conversation and Offer lookups are each batched (one query per
// table, not one per row) — same discipline as resolveVariantPricingInputs.

const { prisma } = require("../lib/prisma");
const {
  loadPricingConfig,
} = require("../services/pricingEngine/pricingConfigLoader");
const {
  computeFloorPrice,
} = require("../services/pricingEngine/computeEnvelope");
const {
  resolveVariantPricingInputs,
} = require("../services/pricingEngine/resolveVariantPricingInputs");

async function listEscalations(req, res) {
  try {
    let page = parseInt(req.query.page, 10);
    let limit = parseInt(req.query.limit, 10);
    page = Number.isFinite(page) && page > 0 ? page : 1;
    limit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 25;

    const where = { action: "escalated_to_human" };
    if (req.query.conversationId) where.entityId = req.query.conversationId;

    const [total, rows] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const conversationIds = [
      ...new Set(rows.map((r) => r.entityId).filter(Boolean)),
    ];
    const offerIds = [
      ...new Set(
        rows
          .map((r) => r.afterState?.offerContext?.currentOfferId)
          .filter(Boolean),
      ),
    ];

    const [conversations, offers] = await Promise.all([
      conversationIds.length
        ? prisma.conversation.findMany({
            where: { id: { in: conversationIds } },
            include: {
              Customer: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  waPhone: true,
                  memberCode: true,
                  tier: true,
                  ltvPercentile: true,
                },
              },
            },
          })
        : [],
      offerIds.length
        ? prisma.offer.findMany({
            where: { id: { in: offerIds } },
            include: {
              Variant: {
                select: {
                  id: true,
                  title: true,
                  sku: true,
                  shopifyVariantId: true,
                },
              },
            },
          })
        : [],
    ]);
    const conversationById = new Map(conversations.map((c) => [c.id, c]));
    const offerById = new Map(offers.map((o) => [o.id, o]));

    const variantIds = [
      ...new Set(offers.map((o) => o.variantId).filter(Boolean)),
    ];
    const config = variantIds.length ? await loadPricingConfig() : null;
    const resolvedVariants = variantIds.length
      ? await resolveVariantPricingInputs(variantIds)
      : {};

    const data = rows.map((row) => {
      const conversation = conversationById.get(row.entityId) || null;
      const offerId = row.afterState?.offerContext?.currentOfferId || null;
      const offer = offerId ? offerById.get(offerId) || null : null;

      let liveFloor = null;
      let liveCost = null;
      if (
        offer &&
        resolvedVariants[offer.variantId] &&
        !resolvedVariants[offer.variantId].error
      ) {
        const { variant } = resolvedVariants[offer.variantId];
        if (variant.costPrice != null) {
          liveCost = Number(variant.costPrice);
          liveFloor = computeFloorPrice({
            costPrice: liveCost,
            listPrice: Number(variant.listPrice),
            config,
          });
        }
      }

      return {
        id: row.id,
        createdAt: row.createdAt,
        reason: row.afterState?.reason || null,
        urgency: row.afterState?.urgency || null,
        conversation: conversation
          ? {
              id: conversation.id,
              waPhone: conversation.waPhone,
              state: conversation.state,
            }
          : null,
        customer: conversation?.Customer || null,
        offer,
        liveFloor,
        liveCost,
      };
    });

    res.json({
      data,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("listEscalations failed:", err);
    res.status(500).json({ error: "Failed to load escalations" });
  }
}

module.exports = { listEscalations };
