// src/services/shopifyProductImport.js
const axios = require("axios");
const { env } = require("../config/env");
const { getValidAccessToken } = require("./shopifyAuth");
const {
  handleProductUpsert,
} = require("../controllers/shopifyWebhookController");

const SHOPIFY_API_VERSION = "2024-10";
const PAGE_LIMIT = 250;

function parseNextPageInfo(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.split(",").find((p) => p.includes('rel="next"'));
  if (!match) return null;
  const urlMatch = match.match(/<([^>]+)>/);
  if (!urlMatch) return null;
  return new URL(urlMatch[1]).searchParams.get("page_info");
}

function fakeReqRes(product) {
  const req = { body: product };
  const res = { status: () => ({ send: () => {} }) };
  return { req, res };
}

async function importAllProducts() {
  const { shopDomain } = env.shopify;
  const accessToken = await getValidAccessToken();

  const client = axios.create({
    baseURL: `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    timeout: 25000,
  });

  let totalImported = 0;
  let pages = 0;
  let pageInfo = null;

  console.log(`Starting Shopify product import from ${shopDomain}...`);

  do {
    const params = { limit: PAGE_LIMIT };
    if (pageInfo) params.page_info = pageInfo;

    const res = await client.get("/products.json", { params });
    const products = res.data?.products || [];

    for (const product of products) {
      const { req, res: fakeRes } = fakeReqRes(product);
      await handleProductUpsert(req, fakeRes);
    }

    totalImported += products.length;
    pages += 1;
    console.log(
      `  page ${pages}: imported ${products.length} products (running total: ${totalImported})`,
    );
    pageInfo = parseNextPageInfo(res.headers?.link);

    if (pageInfo) await new Promise((r) => setTimeout(r, 600));
  } while (pageInfo);

  console.log(
    `Shopify import complete: ${totalImported} products across ${pages} page(s).`,
  );
  return { totalImported, pages };
}

module.exports = { importAllProducts };
