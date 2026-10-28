// src/services/supplierBrandRules.js
//
// Business rule (see supplierProductBackfill.js's header comment): a brand
// belongs to exactly one supplier. Nothing enforced this until now — these
// two helpers back the write endpoints in supplierController.js.
const { prisma } = require("../lib/prisma");

// Checks `brands` against every OTHER active supplier's own brands list.
// Returns one entry per brand that's already claimed, so the caller can
// reject the whole request with a single, specific error rather than a
// generic "brand taken."
async function validateBrandAssignment({ brands, excludeSupplierId }) {
  if (!brands || brands.length === 0) return [];

  const suppliers = await prisma.supplier.findMany({
    where: {
      isActive: true,
      ...(excludeSupplierId ? { id: { not: excludeSupplierId } } : {}),
    },
    select: { id: true, name: true, brands: true },
  });

  const conflicts = [];
  for (const brand of brands) {
    const owner = suppliers.find((s) => s.brands.includes(brand));
    if (owner) {
      conflicts.push({ brand, ownerSupplierId: owner.id, ownerSupplierName: owner.name });
    }
  }
  return conflicts;
}

// Called whenever brands are removed from a supplier (editing the list, or
// deactivating — which clears all of them). A SupplierProduct row that was
// never actually confirmed (no costPrice, never lastConfirmedAt) is purely
// a backfillSupplierProductsByBrand artifact — safe to remove once its
// brand no longer belongs to this supplier. Anything with real confirmed
// pricing/lead-time is left alone for a human to look at, not silently
// deleted just because a brand checkbox got unticked.
async function cleanupUnlinkedBrandProducts({ supplierId, removedBrands }) {
  if (!removedBrands || removedBrands.length === 0) return { deleted: 0, keptForReview: 0 };

  const candidates = await prisma.supplierProduct.findMany({
    where: { supplierId, Product: { vendor: { in: removedBrands } } },
    select: { id: true, costPrice: true, lastConfirmedAt: true },
  });

  const toDeleteIds = candidates
    .filter((c) => c.costPrice === null && c.lastConfirmedAt === null)
    .map((c) => c.id);

  if (toDeleteIds.length > 0) {
    await prisma.supplierProduct.deleteMany({ where: { id: { in: toDeleteIds } } });
  }

  return { deleted: toDeleteIds.length, keptForReview: candidates.length - toDeleteIds.length };
}

module.exports = { validateBrandAssignment, cleanupUnlinkedBrandProducts };
