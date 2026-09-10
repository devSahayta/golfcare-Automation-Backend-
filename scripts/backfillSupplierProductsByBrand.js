// scripts/backfillSupplierProductsByBrand.js
//
// Run this any time a supplier's `brands` list is set or changed (new
// supplier onboarded, or an existing one's brand coverage updated) — see
// src/services/supplierProductBackfill.js for what it actually does.
const {
  backfillSupplierProductsByBrand,
} = require("../src/services/supplierProductBackfill");

backfillSupplierProductsByBrand()
  .then((summary) => {
    console.log("Backfill complete:", JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error("backfillSupplierProductsByBrand script failed:", err.message);
    process.exit(1);
  });
