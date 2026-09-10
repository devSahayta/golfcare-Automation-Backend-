// src/services/supplierProductBackfill.js
//
// Bulk-linked Shopify import (importShopifyProducts.js) creates Product/
// Variant rows with no SupplierProduct — nobody assigned them to a
// supplier, so module 5's recheck dispatch (both cadence and TTL-triggered
// on-demand) has nothing to act on for those variants: cadence dispatch
// loops a supplier's own SupplierProduct rows, and the TTL sweep looks up
// a recheck target via SupplierProduct.isPrimary.
//
// Business rule (confirmed): a brand belongs to exactly one supplier, a
// supplier can carry multiple brands. So Supplier.brands (a list of
// Product.vendor values, e.g. ["Titleist", "FootJoy"]) is enough to derive
// every product that supplier owns — no per-product assignment needed.
// Re-run safe: a variant that already has a SupplierProduct row (from an
// earlier backfill run, or a real supplier confirmation that's since set
// pricing/lead-time on it) is left untouched, never overwritten — this is
// meant to be re-run every time a supplier's brand list changes, not a
// one-time migration.
const { prisma } = require("../lib/prisma");

async function backfillSupplierProductsByBrand() {
  const suppliers = await prisma.supplier.findMany({
    where: { isActive: true, brands: { isEmpty: false } },
  });
  if (suppliers.length === 0) return [];

  const existingLinks = await prisma.supplierProduct.findMany({
    where: { variantId: { not: null } },
    select: { variantId: true, supplierId: true },
  });
  const existingByVariantId = new Map(
    existingLinks.map((l) => [l.variantId, l.supplierId]),
  );

  const summary = [];
  const toCreate = [];

  for (const supplier of suppliers) {
    const products = await prisma.product.findMany({
      where: { vendor: { in: supplier.brands } },
      include: { Variant: true },
    });

    let variantsLinked = 0;
    let alreadyLinked = 0;
    let conflictsWithOtherSupplier = 0;

    for (const product of products) {
      for (const variant of product.Variant) {
        const existingSupplierId = existingByVariantId.get(variant.id);
        if (existingSupplierId) {
          if (existingSupplierId === supplier.id) alreadyLinked += 1;
          else conflictsWithOtherSupplier += 1;
          continue;
        }
        toCreate.push({
          supplierId: supplier.id,
          productId: product.id,
          variantId: variant.id,
          isPrimary: true,
        });
        // Guards against the same variant matching two suppliers' brand
        // lists within this one run (shouldn't happen if the "one brand,
        // one supplier" rule is respected, but cheap to make it safe).
        existingByVariantId.set(variant.id, supplier.id);
        variantsLinked += 1;
      }
    }

    summary.push({
      supplierId: supplier.id,
      supplierName: supplier.name,
      brands: supplier.brands,
      productsMatched: products.length,
      variantsLinked,
      alreadyLinked,
      conflictsWithOtherSupplier,
    });
  }

  if (toCreate.length > 0) {
    await prisma.supplierProduct.createMany({ data: toCreate });
  }

  return summary;
}

module.exports = { backfillSupplierProductsByBrand };
