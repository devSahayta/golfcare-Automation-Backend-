// controllers/availabilityController.js
//
// Dashboard-facing API surface for Module 2 (plan §5). Reads go straight
// through Prisma; the one write path (manual staff override) goes through
// AvailabilityService.setAvailability() like every other caller.

const { prisma } = require("../lib/prisma");
const { setAvailability } = require("../services/availabilityService");

const VALID_STATUSES = [
  "IN_STOCK",
  "OUT_OF_STOCK",
  "ON_ORDER",
  "DISCONTINUED",
  "UNKNOWN",
];

async function listAvailability(req, res) {
  const { status, productId, limit, offset } = req.query;

  if (status && !VALID_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  }

  try {
    const where = {};
    if (status) where.status = status;
    if (productId) where.productId = productId;

    const take = Math.min(Number(limit) || 50, 200);
    const skip = Number(offset) || 0;

    const [items, total] = await Promise.all([
      prisma.availabilityState.findMany({
        where,
        take,
        skip,
        orderBy: { confirmedAt: "desc" },
        include: {
          Variant: { select: { id: true, title: true, sku: true } },
          Product: { select: { id: true, title: true, handle: true } },
        },
      }),
      prisma.availabilityState.count({ where }),
    ]);

    res.json({ items, total, limit: take, offset: skip });
  } catch (err) {
    console.error("listAvailability error:", err);
    res.status(500).json({ error: "Failed to list availability" });
  }
}

async function getAvailabilityByVariant(req, res) {
  const { variantId } = req.params;
  try {
    const availabilityState = await prisma.availabilityState.findUnique({
      where: { variantId },
      include: {
        Variant: { select: { id: true, title: true, sku: true } },
        Product: { select: { id: true, title: true, handle: true } },
        AvailabilityLog: { orderBy: { changedAt: "desc" }, take: 20 },
      },
    });
    if (!availabilityState) {
      return res
        .status(404)
        .json({ error: "No availability state for this variant" });
    }
    res.json({ availabilityState });
  } catch (err) {
    console.error("getAvailabilityByVariant error:", err);
    res.status(500).json({ error: "Failed to fetch availability" });
  }
}

async function overrideAvailability(req, res) {
  const { variantId } = req.params;
  const { status, leadTimeDays, note } = req.body || {};

  if (!status || !VALID_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  }

  try {
    const availabilityState = await setAvailability({
      variantId,
      status,
      source: "MANUAL_OWNER",
      changedBy: req.staffUser.id,
      leadTimeDays: leadTimeDays ?? null,
      note: note ?? null,
    });
    res.json({ availabilityState });
  } catch (err) {
    console.error("overrideAvailability error:", err);
    res
      .status(400)
      .json({ error: err.message || "Failed to override availability" });
  }
}

module.exports = {
  listAvailability,
  getAvailabilityByVariant,
  overrideAvailability,
};
