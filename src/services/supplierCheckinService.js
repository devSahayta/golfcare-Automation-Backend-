// src/services/supplierCheckinService.js
//
// Stock-confirmation logic shared by the Supplier Agent (WhatsApp chat —
// supplierAgentTools.js) and the supplier stock-check portal page
// (supplierPortalController.js). Extracted out of supplierAgentTools.js
// rather than reimplemented so both ways a supplier can confirm stock
// (chat or the portal page) drive the exact same DB/Shopify-sync path and
// can never drift apart. Moved verbatim — comments/reasoning preserved
// from where this originally lived.
const { prisma } = require("../lib/prisma");
const { env } = require("../config/env");
const { setAvailability, bulkSetAvailabilityDbOnly } = require("./availabilityService");
const { updateVariantPrice, updateInventoryItemCost } = require("./shopifyInventory");
const { computeCostPrice } = require("./pricingCalculator");

// The currently-open (status SENT) check-in for a supplier, if any — used
// both by the portal's items list and (replacing its own inline query)
// the agent's list_pending_items tool.
async function getOpenCheckin({ supplierId }) {
  return prisma.supplierCheck.findFirst({
    where: { supplierId, status: "SENT" },
    orderBy: { sentAt: "desc" },
  });
}

// Shared by confirm_availability and reconcile_stock_list — updates the
// SupplierProduct's own record, conditionally drives AvailabilityState
// (module 2's fan-in policy: only isPrimary && variantId), handles the
// margin/GST cost-price calculation (see pricingCalculator.js) when an
// mrp is given, and closes out the open check-in's bookkeeping.
//
// Pricing behaviour: margin/GST are asked for once per SupplierProduct,
// then remembered — if they're already on file (or given again this
// call), the cost price is recomputed from the new mrp and the live
// Shopify price is updated to match (Golf Care is pure dropship — it
// doesn't set retail prices independently of suppliers). If they're
// NOT on file and weren't given, nothing is guessed: the status/leadTime
// side of the confirmation still goes through, but needsPricingInfo comes
// back true so the caller knows to ask the supplier specifically about
// this item, not the whole batch.
async function applyConfirmation({
  supplier,
  supplierProduct,
  status,
  leadTimeDays,
  mrp,
  marginPercent,
  gstPercent,
}) {
  await prisma.supplierProduct.update({
    where: { id: supplierProduct.id },
    data: {
      lastConfirmedStatus: status,
      lastConfirmedAt: new Date(),
    },
  });

  let appliedToAvailability = false;
  if (supplierProduct.isPrimary && supplierProduct.variantId) {
    await setAvailability({
      variantId: supplierProduct.variantId,
      productId: supplierProduct.productId,
      status,
      source: "SUPPLIER_CONFIRMED",
      changedBy: supplier.id,
      leadTimeDays: leadTimeDays ?? null,
    });
    appliedToAvailability = true;
  }

  await recordConfirmationOnOpenCheck({
    supplierId: supplier.id,
    supplierProductId: supplierProduct.id,
    status,
    leadTimeDays: leadTimeDays ?? null,
  });

  let pricingUpdated = false;
  let needsPricingInfo = false;
  if (mrp != null) {
    const resolvedMargin =
      marginPercent != null ? marginPercent : numberOrNull(supplierProduct.marginPercent);
    const resolvedGst =
      gstPercent != null ? gstPercent : numberOrNull(supplierProduct.gstPercent);

    if (resolvedMargin != null && resolvedGst != null) {
      const costPrice = computeCostPrice({
        mrp,
        marginPercent: resolvedMargin,
        gstPercent: resolvedGst,
      });
      await prisma.supplierProduct.update({
        where: { id: supplierProduct.id },
        data: { costPrice, marginPercent: resolvedMargin, gstPercent: resolvedGst },
      });

      if (supplierProduct.variantId) {
        const variant = await prisma.variant.findUnique({
          where: { id: supplierProduct.variantId },
          select: { shopifyVariantId: true },
        });
        if (variant) {
          const [priceResult, costResult] = await Promise.all([
            updateVariantPrice(variant.shopifyVariantId, mrp),
            updateInventoryItemCost(variant.shopifyVariantId, costPrice),
          ]);
          if (!priceResult.ok) {
            console.error(
              `[supplierCheckinService] Shopify price sync failed for variant ${supplierProduct.variantId}:`,
              priceResult.error,
            );
            await prisma.auditLog.create({
              data: {
                actorType: "SYSTEM",
                action: "shopify_price_sync_failed",
                entityType: "Variant",
                entityId: supplierProduct.variantId,
                afterState: { mrp, error: priceResult.error },
                source: "supplier_agent",
              },
            });
          }
          if (!costResult.ok) {
            console.error(
              `[supplierCheckinService] Shopify cost sync failed for variant ${supplierProduct.variantId}:`,
              costResult.error,
            );
            await prisma.auditLog.create({
              data: {
                actorType: "SYSTEM",
                action: "shopify_cost_sync_failed",
                entityType: "Variant",
                entityId: supplierProduct.variantId,
                afterState: { costPrice, error: costResult.error },
                source: "supplier_agent",
              },
            });
          }
        }
      }
      pricingUpdated = true;
    } else {
      needsPricingInfo = true;
    }
  }

  return { appliedToAvailability, pricingUpdated, needsPricingInfo };
}

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

// The blanket-reply counterpart to per-item confirmation — one status
// applied to every item in the currently open check-in, as a single
// cheap backend operation instead of a giant per-item call. Confirmed
// live: without this, a supplier's "all in stock" on a ~2,200-item
// check-in made the chat agent try to enumerate every single item
// individually, which is both far more expensive and can silently
// truncate mid-call at that size.
//
// Every item's own SupplierProduct record gets updated regardless of
// catalog size (a single bulk query — the real source of truth for
// "what did this supplier last say"). AvailabilityState/Shopify sync
// goes through the normal setAvailability() path so the DB write,
// AvailabilityLog, and `availability.changed` event all happen the
// usual way — but the live Shopify inventory write (2-3 Admin API
// calls each) is only attempted inline for the first
// bulkConfirmShopifySyncCap items, processed with bounded concurrency;
// see env.js for why doing this inline for thousands of items isn't
// safe to attempt in one request. Anything beyond the cap still gets
// its DB state updated correctly, just not an inline Shopify push —
// logged to AuditLog as deferred rather than silently dropped.
async function confirmAllPendingItems({ supplier, status, leadTimeDays }) {
  const check = await getOpenCheckin({ supplierId: supplier.id });
  if (!check) return { error: "no_open_check_in" };

  const items = Array.isArray(check.items) ? check.items : [];
  // Only items NOT already individually confirmed this check-in — a
  // blanket "all in stock" must not silently overwrite an item someone
  // (chat or the portal page) already answered differently, e.g. one
  // explicitly marked OUT_OF_STOCK before using the bulk action for
  // everything else. See recordConfirmationOnOpenCheck for where
  // individual confirmations land in rawReplies.confirmations.
  const alreadyConfirmedIds = new Set(
    (Array.isArray(check.rawReplies?.confirmations) ? check.rawReplies.confirmations : []).map(
      (c) => c.supplierProductId,
    ),
  );
  const supplierProductIds = items
    .map((i) => i.supplierProductId)
    .filter((id) => id && !alreadyConfirmedIds.has(id));
  if (supplierProductIds.length === 0) return { error: "check_in_has_no_items" };

  const supplierProducts = await prisma.supplierProduct.findMany({
    where: { id: { in: supplierProductIds }, supplierId: supplier.id },
  });

  await prisma.supplierProduct.updateMany({
    where: { id: { in: supplierProducts.map((sp) => sp.id) } },
    data: { lastConfirmedStatus: status, lastConfirmedAt: new Date() },
  });

  // Module 2's fan-in policy: only the primary supplier's confirmation
  // drives the actual storefront-facing AvailabilityState.
  const primaryTargets = supplierProducts.filter((sp) => sp.isPrimary && sp.variantId);
  const syncCap = env.bulkConfirmShopifySyncCap;

  // Sequential + paced, not concurrent, for the small inline-Shopify
  // slice — confirmed live: concurrency 3 here meant up to 3 variants'
  // worth of Shopify calls in flight at once, and each variant sync is
  // itself up to 3 sequential Admin API calls, so this was really
  // bursting far more than 3 req/sec against a ~2 req/sec limit
  // ("Exceeded 2 calls per second" on 18 of 100). Any call that still
  // fails (rate limit or otherwise) now gets queued for retry too (see
  // availabilityService.js), so this doesn't need to be perfectly
  // rate-safe, just not actively hostile to it.
  const deferredTargets = primaryTargets.slice(syncCap);
  const [syncedResults] = await Promise.all([
    mapSequentialPaced(primaryTargets.slice(0, syncCap), env.shopifySyncPaceMs, (sp) =>
      setAvailability({
        variantId: sp.variantId,
        productId: sp.productId,
        status,
        source: "SUPPLIER_CONFIRMED",
        changedBy: supplier.id,
        leadTimeDays: leadTimeDays ?? null,
      }),
    ),
    // Bulk, not one setAvailability() transaction per item — confirmed
    // live this matters, not just in theory: even DB-only (no Shopify
    // call) at a conservative concurrency of 5, ~2,200 variants took
    // 22.9 minutes over a real network connection to Postgres, useless
    // for anything replying to a WhatsApp message or a page load.
    // bulkSetAvailabilityDbOnly does the same three writes
    // (AvailabilityState, AvailabilityLog, Event) as a handful of bulk
    // queries instead of thousands of individual transactions, and
    // always queues every target for the scheduler's Shopify sync.
    bulkSetAvailabilityDbOnly({
      targets: deferredTargets.map((sp) => ({ variantId: sp.variantId, productId: sp.productId })),
      status,
      source: "SUPPLIER_CONFIRMED",
      changedBy: supplier.id,
      leadTimeDays: leadTimeDays ?? null,
    }),
  ]);

  if (deferredTargets.length > 0) {
    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "shopify_inventory_sync_deferred_bulk_confirm",
        entityType: "SupplierCheck",
        entityId: check.id,
        afterState: {
          supplierId: supplier.id,
          status,
          deferredCount: deferredTargets.length,
        },
        source: "supplier_agent",
      },
    });
  }

  await prisma.supplierCheck.update({
    where: { id: check.id },
    data: {
      status: "ANSWERED",
      respondedAt: new Date(),
      parsedBy: "supplier_agent",
      rawReplies: {
        ...(check.rawReplies || {}),
        blanketConfirmation: { status, confirmedAt: new Date().toISOString() },
      },
    },
  });

  return {
    totalItems: items.length,
    confirmedCount: supplierProducts.length,
    shopifySynced: syncedResults.length,
    shopifyDeferred: deferredTargets.length,
  };
}

// confirmAllPendingItems' pacing helper for the small inline-Shopify
// slice — one at a time, with a real delay between each. Shopify's rate
// limit is per-request, not per-variant, and each variant sync here is
// itself up to 3 sequential requests, so even bounded concurrency
// (confirmed live, at 3) still bursts several times that in requests/sec.
async function mapSequentialPaced(items, delayMs, fn) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    results.push(await fn(items[i]));
    if (i < items.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return results;
}

// Appends this confirmation to the currently-open SupplierCheck's
// rawReplies, and flips it to ANSWERED once every item in `items` has a
// matching confirmation. Re-reads the check fresh rather than trusting
// a cached copy, since a supplier can confirm several items across
// several calls in quick succession (chat turn, or several portal clicks).
async function recordConfirmationOnOpenCheck({
  supplierId,
  supplierProductId,
  status,
  leadTimeDays,
}) {
  const check = await getOpenCheckin({ supplierId });
  if (!check) return; // e.g. supplier volunteering a status update outside any open check-in

  const rawReplies = check.rawReplies || {};
  const confirmations = Array.isArray(rawReplies.confirmations)
    ? rawReplies.confirmations.filter(
        (c) => c.supplierProductId !== supplierProductId,
      )
    : [];
  confirmations.push({
    supplierProductId,
    status,
    leadTimeDays,
    confirmedAt: new Date().toISOString(),
  });

  const items = Array.isArray(check.items) ? check.items : [];
  const allConfirmed =
    items.length > 0 &&
    items.every((item) =>
      confirmations.some(
        (c) => c.supplierProductId === item.supplierProductId,
      ),
    );

  await prisma.supplierCheck.update({
    where: { id: check.id },
    data: {
      rawReplies: { ...rawReplies, confirmations },
      parsedBy: "supplier_agent",
      ...(allConfirmed && { status: "ANSWERED", respondedAt: new Date() }),
    },
  });
}

module.exports = { getOpenCheckin, applyConfirmation, confirmAllPendingItems };
