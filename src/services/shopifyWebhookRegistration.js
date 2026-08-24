// services/shopifyWebhookRegistration.js
//
// Run once (e.g. via a one-off script or an admin endpoint you trigger
// manually) to register webhooks with Shopify. Idempotent — Shopify errors
// on duplicate (topic, address) pairs, which this treats as success.

const axios = require("axios");
const { env } = require("../config/env");
const { getValidAccessToken } = require("./shopifyAuth");

const SHOPIFY_API_VERSION = "2024-10";
const TOPICS = [
  "products/create",
  "products/update",
  "products/delete",
  "inventory_levels/update",
  "orders/create",
  "orders/updated",
  "customers/create",
  "customers/update",
];

async function registerShopifyWebhooks() {
  const { shopDomain, webhookBaseUrl } = env.shopify;
  if (!shopDomain || !webhookBaseUrl) {
    throw new Error(
      "Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_WEBHOOK_BASE_URL env vars.",
    );
  }

  const accessToken = await getValidAccessToken();
  const client = axios.create({
    baseURL: `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });

  const results = [];
  for (const topic of TOPICS) {
    const address = `${webhookBaseUrl}/${topic}`;
    try {
      const res = await client.post("/webhooks.json", {
        webhook: { topic, address, format: "json" },
      });
      results.push({ topic, status: "registered", id: res.data?.webhook?.id });
    } catch (err) {
      const shopifyErrors = err.response?.data?.errors;
      const alreadyExists =
        shopifyErrors &&
        JSON.stringify(shopifyErrors).toLowerCase().includes("already");
      results.push(
        alreadyExists
          ? { topic, status: "already_registered" }
          : { topic, status: "failed", error: shopifyErrors || err.message },
      );
      if (!alreadyExists)
        console.error(
          `registerShopifyWebhooks failed for ${topic}:`,
          shopifyErrors || err.message,
        );
    }
  }
  return results;
}

module.exports = { registerShopifyWebhooks };
