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
//
// Brand transfer: if a variant's existing SupplierProduct row points to a
// supplier that no longer carries that brand (the brand moved to someone
// else), the row is reassigned to the new owner rather than duplicated —
// but its pricing (costPrice/marginPercent/gstPercent/leadTimeDays) and
// confirmation state are reset to null. The old supplier's price/lead-time
// isn't assumed to hold for the new one; it has to be reconfirmed via a
// real stock check.
const { prisma } = require("../lib/prisma");

async function backfillSupplierProductsByBrand({ supplierId } = {}) {
  const targetSuppliers = await prisma.supplier.findMany({
    where: {
      isActive: true,
      brands: { isEmpty: false },
      ...(supplierId ? { id: supplierId } : {}),
    },
  });
  if (targetSuppliers.length === 0) return [];

  const [activeSuppliers, existingLinks] = await Promise.all([
    prisma.supplier.findMany({ where: { isActive: true }, select: { id: true, brands: true } }),
    prisma.supplierProduct.findMany({
      where: { variantId: { not: null } },
      select: { id: true, variantId: true, supplierId: true },
    }),
  ]);
  const brandsBySupplierId = new Map(activeSuppliers.map((s) => [s.id, s.brands]));
  const existingByVariantId = new Map(
    existingLinks.map((l) => [l.variantId, { id: l.id, supplierId: l.supplierId }]),
  );

  const summary = [];
  const toCreate = [];
  const toTransfer = [];

  for (const supplier of targetSuppliers) {
    const products = await prisma.product.findMany({
      where: { vendor: { in: supplier.brands } },
      include: { Variant: true },
    });

    let variantsLinked = 0;
    let alreadyLinked = 0;
    let transferred = 0;
    let conflictsWithOtherSupplier = 0;

    for (const product of products) {
      for (const variant of product.Variant) {
        const existing = existingByVariantId.get(variant.id);
        if (existing) {
          if (existing.supplierId === supplier.id) {
            alreadyLinked += 1;
            continue;
          }
          const ownerStillHasBrand = (brandsBySupplierId.get(existing.supplierId) || []).includes(product.vendor);
          if (ownerStillHasBrand) {
            conflictsWithOtherSupplier += 1;
            continue;
          }
          // Brand moved on from its old owner — reassign the link instead
          // of creating a duplicate, resetting pricing for reconfirmation.
          toTransfer.push({ id: existing.id, newSupplierId: supplier.id });
          existingByVariantId.set(variant.id, { id: existing.id, supplierId: supplier.id });
          transferred += 1;
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
        existingByVariantId.set(variant.id, { id: null, supplierId: supplier.id });
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
      transferred,
      conflictsWithOtherSupplier,
    });
  }

  if (toCreate.length > 0) {
    await prisma.supplierProduct.createMany({ data: toCreate });
  }
  if (toTransfer.length > 0) {
    await prisma.$transaction(
      toTransfer.map((t) =>
        prisma.supplierProduct.update({
          where: { id: t.id },
          data: {
            supplierId: t.newSupplierId,
            costPrice: null,
            marginPercent: null,
            gstPercent: null,
            leadTimeDays: null,
            lastConfirmedStatus: null,
            lastConfirmedAt: null,
          },
        }),
      ),
    );
  }

  return summary;
}

module.exports = { backfillSupplierProductsByBrand };
