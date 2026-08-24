// scripts/importShopifyProducts.js
const { importAllProducts } = require("../src/services/shopifyProductImport");

importAllProducts()
  .then((result) => {
    console.log("Import complete:", result);
    process.exit(0);
  })
  .catch((err) => {
    console.error(
      "importShopifyProducts script failed:",
      err.response?.data || err.message,
    );
    process.exit(1);
  });
