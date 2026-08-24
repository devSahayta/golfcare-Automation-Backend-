// scripts/registerShopifyWebhooks.js
//
// Run once from your local machine (or any environment with the Shopify
// env vars set) to register all 8 webhook topics with Shopify, pointed at
// your deployed backend URL.
//
//   node scripts/registerShopifyWebhooks.js

const {
  registerShopifyWebhooks,
} = require("../src/services/shopifyWebhookRegistration");

registerShopifyWebhooks()
  .then((results) => {
    console.log("Webhook registration results:");
    console.table(results);
    const failed = results.filter((r) => r.status === "failed");
    if (failed.length > 0) {
      console.error(`${failed.length} topic(s) failed to register.`);
      process.exit(1);
    }
    process.exit(0);
  })
  .catch((err) => {
    console.error("registerShopifyWebhooks script failed:", err.message);
    process.exit(1);
  });
