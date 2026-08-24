// routes/shopifyWebhookRoutes.js
//
// Mount in app.js BEFORE app.use(express.json()):
//   app.use("/webhooks/shopify", shopifyWebhookRoutes)
//
// Single-store — no :connectionId in the path (unlike the earlier draft).
// Raw body is required for HMAC verification, so this router applies
// express.raw() itself rather than relying on app.js's express.json().

const express = require("express");
const { verifyShopifyWebhook } = require("../middleware/shopifyWebhookAuth");
const {
  handleProductUpsert,
  handleProductDelete,
  handleInventoryLevelUpdate,
  handleOrderUpsert,
  handleCustomerUpsert,
} = require("../controllers/shopifyWebhookController");

const router = express.Router();

router.use(express.raw({ type: "application/json", limit: "5mb" }));

router.post("/products/create", verifyShopifyWebhook, handleProductUpsert);
router.post("/products/update", verifyShopifyWebhook, handleProductUpsert);
router.post("/products/delete", verifyShopifyWebhook, handleProductDelete);
router.post(
  "/inventory_levels/update",
  verifyShopifyWebhook,
  handleInventoryLevelUpdate,
);
router.post("/orders/create", verifyShopifyWebhook, handleOrderUpsert);
router.post("/orders/updated", verifyShopifyWebhook, handleOrderUpsert);
router.post("/customers/create", verifyShopifyWebhook, handleCustomerUpsert);
router.post("/customers/update", verifyShopifyWebhook, handleCustomerUpsert);

module.exports = router;
