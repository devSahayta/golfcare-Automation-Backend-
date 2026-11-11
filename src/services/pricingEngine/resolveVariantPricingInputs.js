// src/services/pricingEngine/resolveVariantPricingInputs.js
//
// Batched lookup: given a list of variantIds, resolves everything
// computeEnvelope needs about each one — cost (via the primary
// SupplierProduct row), availability status, and the Product fields
// added in Phase 1 — in a small, fixed number of queries, not one query
// per line. A customer asking about 5 items should cost the same as
// asking about 1.

const { prisma } = require("../../lib/prisma");

async function resolveVariantPricingInputs(variantIds) {
  const uniqueIds = [...new Set(variantIds)];

  const [variants, primarySupplierProducts, availabilityStates] =
    await Promise.all([
      prisma.variant.findMany({
        where: { id: { in: uniqueIds } },
        include: { Product: true },
      }),
      // isPrimary is the authoritative cost source per Phase 1's design —
      // see supplierProductBackfill.js / productImportDrain.js, both of
      // which already maintain this flag.
      prisma.supplierProduct.findMany({
        where: { variantId: { in: uniqueIds }, isPrimary: true },
      }),
      prisma.availabilityState.findMany({
        where: { variantId: { in: uniqueIds } },
      }),
    ]);

  const costByVariantId = new Map(
    primarySupplierProducts
      .filter((sp) => sp.variantId)
      .map((sp) => [sp.variantId, sp.costPrice]),
  );
  const availabilityByVariantId = new Map(
    availabilityStates.map((a) => [a.variantId, a.status]),
  );
  const variantById = new Map(variants.map((v) => [v.id, v]));

  const resolved = {};
  for (const variantId of uniqueIds) {
    const variant = variantById.get(variantId);
    if (!variant) {
      resolved[variantId] = { error: "variant_not_found" };
      continue;
    }
    const costPrice = costByVariantId.get(variantId) ?? null;
    // No AvailabilityState row at all = never checked = UNKNOWN, same
    // posture as check_availability's own existing fallback.
    const availabilityStatus =
      availabilityByVariantId.get(variantId) || "UNKNOWN";

    resolved[variantId] = {
      variant: {
        id: variant.id,
        shopifyVariantId: variant.shopifyVariantId,
        listPrice: variant.price,
        costPrice,
        availabilityStatus,
      },
      product: {
        id: variant.Product.id,
        vendor: variant.Product.vendor,
        productType: variant.Product.productType,
        tags: variant.Product.tags,
        isSeasonal: variant.Product.isSeasonal,
        pricingLocked: variant.Product.pricingLocked,
        supersededById: variant.Product.supersededById,
      },
    };
  }
  return resolved;
}

module.exports = { resolveVariantPricingInputs };
