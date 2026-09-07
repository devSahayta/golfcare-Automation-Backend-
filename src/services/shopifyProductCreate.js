// src/services/shopifyProductCreate.js
//
// Module 5.2 — creates a new Shopify product as an unpublished draft
// (status: "draft" — exists in the store, invisible/unpurchasable) so
// approval later is just one PUT flipping status to "active", not a
// separate "build the product" step. Reuses the exact auth/client pattern
// already established in shopifyProductImport.js / shopifyInventory.js.
//
// If the supplier gave a quantity at draft time, that's set directly on
// the variant at creation (inventory_management + inventory_quantity —
// Shopify accepts both in the same POST that creates the variant, unlike
// an existing variant which needs a separate inventory_levels/set call,
// what services/shopifyInventory.js's ensureInventoryTracked does for
// module 2). No quantity given still leaves tracking off, same
// lazy-tracking approach as before — module 2 turns it on whenever a real
// availability confirmation first comes in.

const axios = require("axios");
const { env } = require("../config/env");
const { getValidAccessToken } = require("./shopifyAuth");

const SHOPIFY_API_VERSION = "2024-10";

async function shopifyClient() {
  const accessToken = await getValidAccessToken();
  return axios.create({
    baseURL: `https://${env.shopify.shopDomain}/admin/api/${SHOPIFY_API_VERSION}`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
}

async function shopifyGraphqlClient() {
  const accessToken = await getValidAccessToken();
  return axios.create({
    baseURL: `https://${env.shopify.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    headers: {
      "X-Shopify-Access-Token": accessToken,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

// Publications (sales channels) rarely change, and REST has no endpoint
// for this — cached per-process the same way shopifyInventory.js caches
// the store's location id.
let cachedPublicationIds = null;
async function getAllPublicationIds() {
  if (cachedPublicationIds) return cachedPublicationIds;
  const client = await shopifyGraphqlClient();
  const res = await client.post("", {
    query: "{ publications(first: 10) { edges { node { id } } } }",
  });
  if (res.data.errors) throw new Error(JSON.stringify(res.data.errors));
  cachedPublicationIds = res.data.data.publications.edges.map((e) => e.node.id);
  return cachedPublicationIds;
}

// REST product creation only auto-publishes to one channel (observed: a
// freshly created product showed up with 1 channel while every normal
// active product in the store has 2 — "Online Store" and "Point of
// Sale"). Publish explicitly to all of them, even while still draft —
// publication and draft/active status are independent in Shopify, so
// pre-publishing now means nothing extra needs to happen at approval time.
async function publishToAllChannels(shopifyProductId) {
  const publicationIds = await getAllPublicationIds();
  const client = await shopifyGraphqlClient();
  const res = await client.post("", {
    query: `mutation publishablePublish($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        userErrors { field message }
      }
    }`,
    variables: {
      id: `gid://shopify/Product/${shopifyProductId}`,
      input: publicationIds.map((id) => ({ publicationId: id })),
    },
  });
  const errors = res.data.errors || res.data.data?.publishablePublish?.userErrors;
  if (errors?.length) {
    console.error("[shopifyProductCreate] publishablePublish errors:", JSON.stringify(errors));
  }
}

/**
 * @param {object} input
 * @param {string} input.title
 * @param {number} input.price
 * @param {string} [input.category] - maps to Shopify's product_type
 * @param {string} [input.specs] - prose description only; brand/sku/size
 *   have their own dedicated fields below and shouldn't be duplicated here
 * @param {string} [input.brand] - maps to Shopify's vendor field
 * @param {string} [input.sku] - maps to the variant's sku, not body_html
 * @param {{name: string, value: string}[]} [input.variantOptions] - up to
 *   3, e.g. [{name:"Size",value:"M"}] — becomes a real Shopify variant
 *   option (option1/2/3), not text in the description
 * @param {string} [input.imageUrl] - e.g. a supplier's WhatsApp media URL, or one found via web search
 * @param {number} [input.quantity] - if the supplier gave a stock count, sets real tracked inventory at creation
 * @returns {Promise<{shopifyProductId: string, handle: string, imageIncluded: boolean}>}
 */
async function createDraftProduct({
  title,
  price,
  category,
  specs,
  brand,
  sku,
  variantOptions,
  imageUrl,
  quantity,
}) {
  const client = await shopifyClient();

  const options = Array.isArray(variantOptions) ? variantOptions.slice(0, 3) : [];
  const variant = { price: String(price) };
  if (sku) variant.sku = sku;
  if (quantity != null) {
    variant.inventory_management = "shopify";
    variant.inventory_quantity = quantity;
  }
  options.forEach((opt, i) => {
    variant[`option${i + 1}`] = opt.value;
  });

  const buildPayload = (withImage) => ({
    product: {
      title,
      body_html: specs || undefined,
      product_type: category || undefined,
      vendor: brand || undefined,
      status: "draft",
      ...(options.length ? { options: options.map((o) => ({ name: o.name })) } : {}),
      variants: [variant],
      ...(withImage && imageUrl ? { images: [{ src: imageUrl }] } : {}),
    },
  });

  let product;
  let imageIncluded = Boolean(imageUrl);
  try {
    const res = await client.post("/products.json", buildPayload(true));
    product = res.data.product;
  } catch (err) {
    if (!imageUrl) throw err;
    // WhatsApp media URLs can be short-lived — a dead image src is a
    // plausible, recoverable failure mode given we deliberately don't
    // have our own storage for these (module 5.2 decision). Don't lose
    // the whole draft over an image Shopify couldn't fetch.
    console.error(
      "[shopifyProductCreate] creation with image failed, retrying without image:",
      err.response?.data || err.message,
    );
    const res = await client.post("/products.json", buildPayload(false));
    product = res.data.product;
    imageIncluded = false;
  }

  return {
    shopifyProductId: String(product.id),
    shopifyVariantId: String(product.variants[0].id),
    handle: product.handle,
    imageIncluded,
  };
}

// Publishing to channels while still status:"draft" is a silent no-op in
// Shopify — verified directly (the mutation reports success with zero
// userErrors but resourcePublications stays empty). Channel publication
// only actually takes effect once the product is active, which is why
// this happens here rather than at draft-creation time. Also verified:
// the status flip alone only gets ONE of the two channels (observed:
// "Point of Sale" but not "Online Store") — the explicit publish call
// after flipping is what closes the gap to both.
async function publishProduct(shopifyProductId) {
  const client = await shopifyClient();
  await client.put(`/products/${shopifyProductId}.json`, {
    product: { id: Number(shopifyProductId), status: "active" },
  });

  try {
    await publishToAllChannels(shopifyProductId);
  } catch (err) {
    // Best-effort — the product is genuinely live either way; a missed
    // channel is a smaller problem than losing the approval over it.
    console.error(
      "[shopifyProductCreate] publishToAllChannels failed:",
      err.response?.data || err.message,
    );
  }
}

module.exports = { createDraftProduct, publishProduct, publishToAllChannels };
