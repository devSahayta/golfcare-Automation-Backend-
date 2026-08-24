// config/env.js
require("dotenv").config();

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.API_PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || "",
  samvaadik: {
    baseUrl: process.env.SAMVAADIK_API_BASE_URL || "",
    apiKey: process.env.SAMVAADIK_API_KEY || "",
    webhookSecret: process.env.SAMVAADIK_WEBHOOK_SECRET || "",
  },
  shopify: {
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || "",
    clientId: process.env.SHOPIFY_CLIENT_ID || "",
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
    webhookBaseUrl: process.env.SHOPIFY_WEBHOOK_BASE_URL || "",
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  approvalLinkBaseUrl:
    process.env.APPROVAL_LINK_BASE_URL || "http://localhost:4000",
};

module.exports = { env };
