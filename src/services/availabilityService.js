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

const crypto = require("crypto");
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
 * @param {boolean} [input.skipShopifySync] - skip the Shopify write-back for this call (DB stays the source of truth either way). Used by bulk callers confirming hundreds/thousands of variants in one request — each Shopify write is itself 2-3 Admin API calls (see shopifyInventory.js), so doing it inline for every item risks the request timing out and hammering Shopify's rate limit; see supplierAgentTools.js's confirm_all_pending_items for the bounded-inline-count pattern this enables.
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
  skipShopifySync = false,
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

  if (skipShopifySync) {
    // The DB write above already committed — that's Golf Care OS's real
    // source of truth. This just leaves a breadcrumb for the scheduler's
    // shopifySyncQueueDrain job to push the Shopify inventory level later,
    // instead of silently never syncing it at all.
    await prisma.shopifySyncQueue
      .create({ data: { variantId, status } })
      .catch((err) => {
        console.error(
          `[availabilityService] failed to enqueue deferred Shopify sync for variant ${variantId}:`,
          err.message,
        );
      });
    return { ...availabilityState, shopifySynced: false, shopifySyncSkipped: true };
  }

  const shopifyResult = await writeAvailabilityToShopify(
    { shopifyVariantId: variant.shopifyVariantId },
    status,
  );

  if (!shopifyResult.ok) {
    console.error(
      `[availabilityService] Shopify write-back failed for variant ${variantId}:`,
      shopifyResult.error,
    );
    // A genuine failure (e.g. Shopify rate limiting — confirmed live: 18
    // of a 100-item inline bulk-confirm batch hit "Exceeded 2 calls per
    // second") used to only get logged here, never retried — silently
    // leaving Golf Care OS's own DB correct but Shopify's live inventory
    // permanently stale for that variant. Same queue the deliberate
    // skipShopifySync path already uses, so one scheduler job (see
    // shopifySyncQueueDrain.js) catches up both deferred AND failed syncs.
    await prisma.shopifySyncQueue
      .create({ data: { variantId, status } })
      .catch((err) => {
        console.error(
          `[availabilityService] failed to enqueue retry for variant ${variantId}:`,
          err.message,
        );
      });
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

// Bulk DB-only sibling of setAvailability() — same status, same source,
// applied to hundreds/thousands of variants in a handful of queries
// instead of one transaction per variant. Built after confirming live
// that the "obvious" fix (setAvailability() in a loop, even DB-only with
// skipShopifySync and modest concurrency) is fundamentally too slow at
// real scale over a real network connection to Postgres — 2,212 variants
// that way took 22.9 minutes, useless for anything that has to reply to a
// WhatsApp message. This does the same three writes (AvailabilityState,
// AvailabilityLog, Event) as bulk operations, and always queues every
// target for the scheduler's Shopify sync — there is no non-bulk Shopify
// path here at all, unlike setAvailability's optional skipShopifySync.
//
// @param {object} input
// @param {{variantId: string, productId: string}[]} input.targets
// @param {"IN_STOCK"|"OUT_OF_STOCK"|"ON_ORDER"|"DISCONTINUED"|"UNKNOWN"} input.status
// @param {"SUPPLIER_CONFIRMED"|"MANUAL_OWNER"|"AGENT_INFERRED"} input.source
// @param {string} [input.changedBy]
// @param {number} [input.leadTimeDays]
// @param {string} [input.note] - explicit note for this write; defaults to
//   clearing any prior note (matches setAvailability's own default), NOT
//   leaving whatever was there before. Confirmed live: without this, a
//   variant's "Confirmation expired (TTL sweep)" note from the TTL sweep
//   was still sitting there after a real supplier reconfirmation via this
//   function, because the updateMany simply never mentioned the column.
// @param {number} [input.ttlHours]
// @returns {Promise<number>} how many variants were written
async function bulkSetAvailabilityDbOnly({
  targets,
  status,
  source,
  changedBy,
  leadTimeDays = null,
  note = null,
  ttlHours,
}) {
  if (!Array.isArray(targets) || targets.length === 0) return 0;
  if (!status) throw new Error("bulkSetAvailabilityDbOnly: status is required");
  if (!source) throw new Error("bulkSetAvailabilityDbOnly: source is required");

  const variantIds = targets.map((t) => t.variantId);
  const now = new Date();
  const expiresAt = new Date(
    now.getTime() + (ttlHours ?? env.availabilityTtlHours) * 60 * 60 * 1000,
  );

  const existing = await prisma.availabilityState.findMany({
    where: { variantId: { in: variantIds } },
    select: { id: true, variantId: true, status: true },
  });
  const existingByVariantId = new Map(existing.map((e) => [e.variantId, e]));

  const toUpdateVariantIds = [];
  const toCreate = [];
  for (const t of targets) {
    if (existingByVariantId.has(t.variantId)) {
      toUpdateVariantIds.push(t.variantId);
    } else {
      // Id generated client-side (Prisma accepts an explicit value even
      // though the column has a DB-side default) so AvailabilityLog below
      // can reference it without a second round-trip to re-read what
      // createMany just inserted — createMany doesn't return rows.
      toCreate.push({
        id: crypto.randomUUID(),
        variantId: t.variantId,
        productId: t.productId,
        status,
        source,
        leadTimeDays,
        confirmedBy: changedBy || null,
        confirmedAt: now,
        expiresAt,
        note,
      });
    }
  }

  if (toUpdateVariantIds.length > 0) {
    await prisma.availabilityState.updateMany({
      where: { variantId: { in: toUpdateVariantIds } },
      data: {
        status,
        source,
        leadTimeDays,
        confirmedBy: changedBy || null,
        confirmedAt: now,
        expiresAt,
        note,
      },
    });
  }
  if (toCreate.length > 0) {
    await prisma.availabilityState.createMany({ data: toCreate });
  }

  const stateIdByVariantId = new Map(existing.map((e) => [e.variantId, e.id]));
  toCreate.forEach((row) => stateIdByVariantId.set(row.variantId, row.id));

  // Raw SQL via unnest(), not prisma.availabilityLog.createMany() and not
  // a VALUES-list of Prisma.sql rows either — both confirmed live as
  // genuinely too slow at real scale, for two different reasons stacked
  // on each other:
  //   1. createMany() on this exact table took 14.5s for just 50 rows,
  //      even though EXPLAIN ANALYZE showed the underlying INSERT itself
  //      is ~1.5ms (FK trigger to AvailabilityState included) — an 18x gap
  //      not explained by RLS (identical on every table in this schema,
  //      including ones that were fast) or anything visible in the query
  //      plan, so treat it as a known-bad path for this table's shape
  //      (required FK + nullable enum column) rather than dig further.
  //   2. A hand-built multi-row VALUES list, even fully parameterized via
  //      Prisma.sql/Prisma.join (one bind parameter per cell), was WORSE:
  //      still hadn't finished after 2 minutes at 1,000 rows (6,000 bind
  //      parameters). unnest() takes one array parameter per COLUMN
  //      instead — 5 parameters total regardless of row count — and ran
  //      the identical 1,000-row insert in 1.2s. Casts happen AFTER
  //      unnest(), on the scalar per-row value, not on the array itself —
  //      casting an all-NULL array directly to "AvailStatus"[] fails
  //      (Postgres can't infer the array's element type from the driver),
  //      but casting each unnested NULL to "AvailStatus" is a normal,
  //      always-valid NULL.
  const logIds = targets.map(() => crypto.randomUUID());
  const logStateIds = targets.map((t) => stateIdByVariantId.get(t.variantId));
  const logPrevStatuses = targets.map((t) => existingByVariantId.get(t.variantId)?.status ?? null);
  const logChangedBy = changedBy || "system";
  await prisma.$executeRaw`
    INSERT INTO "AvailabilityLog" (id, "availabilityStateId", "previousStatus", "newStatus", "changedBy", "changedAt")
    SELECT id, "availabilityStateId", "previousStatus"::"AvailStatus", ${status}::"AvailStatus", ${logChangedBy}, ${now}::timestamptz
    FROM unnest(${logIds}::text[], ${logStateIds}::text[], ${logPrevStatuses}::text[])
    AS t(id, "availabilityStateId", "previousStatus")
  `;

  await prisma.event.createMany({
    data: targets.map((t) => ({
      type: "availability.changed",
      payload: {
        variantId: t.variantId,
        productId: t.productId,
        previousStatus: existingByVariantId.get(t.variantId)?.status ?? null,
        newStatus: status,
        source,
        changedBy: changedBy || null,
      },
    })),
  });

  // Every target here was DB-only by construction — queue all of them for
  // the scheduler's shopifySyncQueueDrain job, same table setAvailability's
  // skipShopifySync/failure paths use.
  await prisma.shopifySyncQueue.createMany({
    data: targets.map((t) => ({ variantId: t.variantId, status })),
  });

  return targets.length;
}

module.exports = { setAvailability, bulkSetAvailabilityDbOnly };
