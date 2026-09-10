// scripts/trimSupplierProductsForTesting.js
//
// Cadence dispatch (Module 5.1) sends one check-in per supplier covering
// EVERY SupplierProduct they own — fine in production, unusable for
// testing once a supplier owns thousands of variants (see
// supplierProductBackfill.js). This trims each supplier down to a small,
// human-testable set WITHOUT touching Supplier.brands, so it's fully
// reversible: re-run backfillSupplierProductsByBrand.js afterward to
// instantly restore full catalog coverage (it only fills gaps left by
// this trim, never removes anything).
const { prisma } = require("../src/lib/prisma");

const KEEP_PER_SUPPLIER = Number(process.argv[2] || 5);

async function trimSupplierProductsForTesting() {
  const suppliers = await prisma.supplier.findMany({ where: { isActive: true } });

  for (const supplier of suppliers) {
    const rows = await prisma.supplierProduct.findMany({
      where: { supplierId: supplier.id },
      include: { Product: { select: { title: true } } },
      orderBy: { id: "asc" },
    });

    const toKeep = rows.slice(0, KEEP_PER_SUPPLIER);
    const toDelete = rows.slice(KEEP_PER_SUPPLIER);

    if (toDelete.length > 0) {
      await prisma.supplierProduct.deleteMany({
        where: { id: { in: toDelete.map((r) => r.id) } },
      });
    }

    console.log(
      `${supplier.name}: kept ${toKeep.length} (${toKeep.map((r) => r.Product.title).join(", ")}), deleted ${toDelete.length}.`,
    );
  }
}

trimSupplierProductsForTesting()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("trimSupplierProductsForTesting script failed:", err.message);
    process.exit(1);
  });
