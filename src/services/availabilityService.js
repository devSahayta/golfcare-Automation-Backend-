// src/services/availabilityService.js
//
// Module 2 core. Every availability change in Golf Care OS — a supplier
// confirming stock (Module 5), a staff override (dashboard), or the TTL
// sweep flipping a stale row to UNKNOWN (scheduler) — goes through
// setAvailability(). It is the only writer of AvailabilityState.
//
// Ordering: the DB write (state + log + event) commits in one transaction
// first — that's Golf Care OS's own source of truth for availability. The
// Shopify write-back happens after, best-effort: a Shopify/network blip
// must never block or roll back the OS's own availability pipeline. A
// failed Shopify sync is recorded to AuditLog (for the dashboard to
// surface later) rather than retried indefinitely or allowed to fail the
// caller's request.
//
// Supplier fan-in policy (open decision, plan §4): a variant can have
// multiple SupplierProduct rows. Only the primary supplier's confirmation
// should call setAvailability() directly — others should just update
// their own SupplierProduct.lastConfirmedStatus for reliability tracking.
// Enforce that at the Module 5 call site; this function is call-site
// agnostic.

const { prisma } = require("../lib/prisma");
const { writeAvailabilityToShopify } = require("./shopifyInventory");
const { env } = require("../config/env");

function invalidateProductCache(_variantId) {
  // TODO (Module 3): bust the Sales Agent's product read-cache here once
  // it exists, so the concierge agent never quotes stale stock on the
  // very next message.
}

/**
 * @param {object} input
 * @param {string} input.variantId
 * @param {string} [input.productId] - derived from the variant if omitted
 * @param {"IN_STOCK"|"OUT_OF_STOCK"|"ON_ORDER"|"DISCONTINUED"|"UNKNOWN"} input.status
 * @param {"SUPPLIER_CONFIRMED"|"MANUAL_OWNER"|"AGENT_INFERRED"} input.source
 * @param {string} [input.changedBy] - staff user id, supplier id, or a system label like "system:ttl-sweep"
 * @param {number} [input.leadTimeDays]
 * @param {string} [input.note]
 * @param {number} [input.ttlHours] - overrides the default TTL (env AVAILABILITY_TTL_HOURS) for this write
 */
async function setAvailability({
  variantId,
  productId,
  status,
  source,
  changedBy,
  leadTimeDays = null,
  note = null,
  ttlHours,
}) {
  if (!variantId) throw new Error("setAvailability: variantId is required");
  if (!status) throw new Error("setAvailability: status is required");
  if (!source) throw new Error("setAvailability: source is required");

  const variant = await prisma.variant.findUnique({
    where: { id: variantId },
    select: { id: true, productId: true, shopifyVariantId: true },
  });
  if (!variant) {
    throw new Error(`setAvailability: variant ${variantId} not found`);
  }
  const resolvedProductId = productId || variant.productId;

  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + (ttlHours ?? env.availabilityTtlHours) * 60 * 60 * 1000,
  );

  const { availabilityState, previousStatus } = await prisma.$transaction(
    async (tx) => {
      const existing = await tx.availabilityState.findUnique({
        where: { variantId },
        select: { status: true },
      });

      const state = await tx.availabilityState.upsert({
        where: { variantId },
        create: {
          variantId,
          productId: resolvedProductId,
          status,
          source,
          leadTimeDays,
          confirmedBy: changedBy || null,
          confirmedAt: now,
          expiresAt,
          note,
        },
        update: {
          productId: resolvedProductId,
          status,
          source,
          leadTimeDays,
          confirmedBy: changedBy || null,
          confirmedAt: now,
          expiresAt,
          note,
        },
      });

      await tx.availabilityLog.create({
        data: {
          availabilityStateId: state.id,
          previousStatus: existing?.status ?? null,
          newStatus: status,
          changedBy: changedBy || "system",
        },
      });

      await tx.event.create({
        data: {
          type: "availability.changed",
          payload: {
            variantId,
            productId: resolvedProductId,
            previousStatus: existing?.status ?? null,
            newStatus: status,
            source,
            changedBy: changedBy || null,
          },
        },
      });

      return { availabilityState: state, previousStatus: existing?.status ?? null };
    },
  );

  invalidateProductCache(variantId);

  const shopifyResult = await writeAvailabilityToShopify(
    { shopifyVariantId: variant.shopifyVariantId },
    status,
  );

  if (!shopifyResult.ok) {
    console.error(
      `[availabilityService] Shopify write-back failed for variant ${variantId}:`,
      shopifyResult.error,
    );
    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "shopify_inventory_sync_failed",
        entityType: "Variant",
        entityId: variantId,
        beforeState: { status: previousStatus },
        afterState: { status, error: shopifyResult.error },
        source: "availability_service",
      },
    });
  }

  return { ...availabilityState, shopifySynced: shopifyResult.ok };
}

module.exports = { setAvailability };
