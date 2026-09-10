// scripts/assignRemainingVendorsToSuppliers.js
//
// One-time test-data helper: every Product.vendor not yet owned by any
// supplier gets assigned to one of the existing suppliers, round-robin by
// product count (keeps volume roughly balanced across suppliers). Never
// reassigns a vendor a supplier already has (respects "one brand, one
// supplier"); null vendors are left alone. Appends onto each supplier's
// existing `brands` list rather than overwriting it.
//
// This is specifically for filling in test coverage across the whole
// catalog — the real onboarding step for an actual new supplier is still
// "set Supplier.brands to what they really carry, then run
// backfillSupplierProductsByBrand.js" (see that script's header).
const { prisma } = require("../src/lib/prisma");
const {
  backfillSupplierProductsByBrand,
} = require("../src/services/supplierProductBackfill");

async function assignRemainingVendorsToSuppliers() {
  const suppliers = await prisma.supplier.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
  });
  if (suppliers.length === 0) {
    console.log("No active suppliers to assign vendors to.");
    return;
  }

  const ownedBrands = new Set(suppliers.flatMap((s) => s.brands));

  const vendorCounts = await prisma.product.groupBy({
    by: ["vendor"],
    _count: { vendor: true },
    orderBy: { _count: { vendor: "desc" } },
  });
  const unassignedVendors = vendorCounts
    .map((v) => v.vendor)
    .filter((vendor) => vendor && !ownedBrands.has(vendor));

  const newBrandsBySupplier = new Map(suppliers.map((s) => [s.id, []]));
  unassignedVendors.forEach((vendor, i) => {
    const supplier = suppliers[i % suppliers.length];
    newBrandsBySupplier.get(supplier.id).push(vendor);
  });

  for (const supplier of suppliers) {
    const additions = newBrandsBySupplier.get(supplier.id);
    if (additions.length === 0) continue;
    await prisma.supplier.update({
      where: { id: supplier.id },
      data: { brands: [...supplier.brands, ...additions] },
    });
    console.log(`${supplier.name}: +${additions.length} brands -> ${additions.join(", ")}`);
  }

  console.log(`\n${unassignedVendors.length} vendor(s) newly assigned. Running SupplierProduct backfill...`);
  const summary = await backfillSupplierProductsByBrand();
  console.log("Backfill complete:", JSON.stringify(summary, null, 2));
}

assignRemainingVendorsToSuppliers()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("assignRemainingVendorsToSuppliers script failed:", err.message);
    process.exit(1);
  });
