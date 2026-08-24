// services/shopifyAuth.js
//
// Single-store token handling. Golf Care OS has no ShopifyConnection table —
// one shop, credentials from env vars. Custom-app (Dev Dashboard) tokens
// from the client_credentials grant expire, so this caches the token
// in-memory and refreshes it a few minutes before expiry.

const axios = require("axios");
const { env } = require("../config/env");

let cachedToken = null;
let cachedExpiresAt = 0;
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

async function fetchAccessToken() {
  const { shopDomain, clientId, clientSecret } = env.shopify;
  if (!shopDomain || !clientId || !clientSecret) {
    throw new Error(
      "Missing SHOPIFY_SHOP_DOMAIN / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET env vars.",
    );
  }

  const response = await axios.post(
    `https://${shopDomain}/admin/oauth/access_token`,
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    }),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    },
  );
  return response.data; // { access_token, scope, expires_in }
}

async function getValidAccessToken() {
  const isExpired = cachedExpiresAt - Date.now() < REFRESH_BUFFER_MS;
  if (cachedToken && !isExpired) return cachedToken;

  const tokenData = await fetchAccessToken();
  cachedToken = tokenData.access_token;
  cachedExpiresAt = Date.now() + tokenData.expires_in * 1000;
  return cachedToken;
}

module.exports = { getValidAccessToken };
