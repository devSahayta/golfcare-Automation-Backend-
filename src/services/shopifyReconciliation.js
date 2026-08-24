// services/shopifyReconciliation.js
//
// Run nightly (from wherever Golf Care OS's scheduler lives). Single store,
// so this is just importAllProducts() again — Shopify is the source of
// truth, so "reconcile" and "re-import everything" are the same operation.
//
// Wire into your scheduler, e.g.:
//   const cron = require("node-cron");
//   const { reconcileShopify } = require("./services/shopifyReconciliation");
//   cron.schedule("0 3 * * *", reconcileShopify); // 3 AM daily

const { importAllProducts } = require("./shopifyProductImport");

async function reconcileShopify() {
  try {
    const result = await importAllProducts();
    console.log("Shopify reconciliation complete:", result);
    return result;
  } catch (err) {
    console.error(
      "Shopify reconciliation failed:",
      err.response?.data || err.message,
    );
    // TODO: surface this failure somewhere a human sees it, not just logs.
    throw err;
  }
}

module.exports = { reconcileShopify };
