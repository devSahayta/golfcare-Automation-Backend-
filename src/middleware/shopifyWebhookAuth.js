// middleware/shopifyWebhookAuth.js
//
// Single-store HMAC verification — no DB lookup needed since there's only
// one shop. Verifies against SHOPIFY_CLIENT_SECRET (custom apps sign
// webhooks with the same secret used for the client_credentials token
// exchange — there's no separate "webhook secret" for Dev Dashboard apps).
//
// MUST be mounted with express.raw({ type: "application/json" }) — see
// routes/shopifyWebhookRoutes.js. Verifying against JSON.parse()'d and
// re-stringified data can produce different bytes and silently fail.

const crypto = require("crypto");
const { env } = require("../config/env");

function verifyShopifyWebhook(req, res, next) {
  try {
    const hmacHeader = req.get("X-Shopify-Hmac-Sha256");
    if (!hmacHeader) {
      return res.status(401).send("Missing HMAC header");
    }

    if (!Buffer.isBuffer(req.body)) {
      console.error(
        "shopifyWebhookAuth: req.body is not a raw Buffer. Check route mounting order in app.js — this router must be mounted before app.use(express.json()).",
      );
      return res.status(500).send("Server misconfiguration");
    }

    const secret = env.shopify.clientSecret;
    if (!secret) {
      console.error("shopifyWebhookAuth: SHOPIFY_CLIENT_SECRET is not set.");
      return res.status(500).send("Server misconfiguration");
    }

    const digest = crypto
      .createHmac("sha256", secret)
      .update(req.body)
      .digest("base64");

    const valid = crypto.timingSafeEqual(
      Buffer.from(digest, "utf8"),
      Buffer.from(hmacHeader, "utf8"),
    );

    if (!valid) {
      return res.status(401).send("Invalid HMAC");
    }

    req.shopifyTopic = req.get("X-Shopify-Topic");
    req.shopifyWebhookId = req.get("X-Shopify-Webhook-Id");
    req.rawBody = req.body;
    req.body = JSON.parse(req.body.toString("utf8"));

    next();
  } catch (err) {
    console.error("shopifyWebhookAuth error:", err);
    return res.status(500).send("Webhook verification failed");
  }
}

module.exports = { verifyShopifyWebhook };
