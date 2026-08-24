// controllers/shopifyWebhookController.js
//
// Prisma-based, matched to the real schema:
//   - Product.shopifyProductId / Variant.shopifyVariantId / Order.shopifyOrderId
//     are all Strings, unique — Shopify's numeric ids are cast to String.
//   - Upserts on those unique fields are naturally idempotent: a re-delivered
//     webhook just re-writes the same row, so there's no separate webhook-
//     event log table needed (there isn't one in the schema).
//   - Variant has no stock-quantity field — availability is a separate,
//     explicitly-confirmed concept (AvailabilityState: source is
//     SUPPLIER_CONFIRMED / MANUAL_OWNER / AGENT_INFERRED). So
//     inventory_levels/update does NOT write inventory numbers anywhere
//     yet — see handleInventoryLevelUpdate below.

const { prisma } = require("../lib/prisma");

function computePriceRange(variants) {
  const prices = (variants || [])
    .map((v) => parseFloat(v.price))
    .filter((p) => !Number.isNaN(p));
  if (prices.length === 0) return { priceMin: 0, priceMax: 0 };
  return { priceMin: Math.min(...prices), priceMax: Math.max(...prices) };
}

/* ─── products/create, products/update ──────────────────────────────────── */

async function handleProductUpsert(req, res) {
  const product = req.body;
  res.status(200).send("ok"); // respond fast; Shopify expects <5s

  try {
    const { priceMin, priceMax } = computePriceRange(product.variants);

    const savedProduct = await prisma.product.upsert({
      where: { shopifyProductId: String(product.id) },
      create: {
        shopifyProductId: String(product.id),
        handle: product.handle,
        title: product.title,
        vendor: product.vendor || null,
        productType: product.product_type || null,
        tags: product.tags
          ? product.tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        descriptionHtml: product.body_html || null,
        imageUrls: (product.images || []).map((img) => img.src),
        priceMin,
        priceMax,
        status: product.status,
        syncedAt: new Date(),
      },
      update: {
        handle: product.handle,
        title: product.title,
        vendor: product.vendor || null,
        productType: product.product_type || null,
        tags: product.tags
          ? product.tags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [],
        descriptionHtml: product.body_html || null,
        imageUrls: (product.images || []).map((img) => img.src),
        priceMin,
        priceMax,
        status: product.status,
        syncedAt: new Date(),
      },
    });

    for (const v of product.variants || []) {
      await prisma.variant.upsert({
        where: { shopifyVariantId: String(v.id) },
        create: {
          shopifyVariantId: String(v.id),
          productId: savedProduct.id,
          sku: v.sku || null,
          title: v.title || "Default",
          price: v.price ? parseFloat(v.price) : 0,
          compareAtPrice: v.compare_at_price
            ? parseFloat(v.compare_at_price)
            : null,
          optionValues: {
            option1: v.option1 || null,
            option2: v.option2 || null,
            option3: v.option3 || null,
          },
        },
        update: {
          sku: v.sku || null,
          title: v.title || "Default",
          price: v.price ? parseFloat(v.price) : 0,
          compareAtPrice: v.compare_at_price
            ? parseFloat(v.compare_at_price)
            : null,
          optionValues: {
            option1: v.option1 || null,
            option2: v.option2 || null,
            option3: v.option3 || null,
          },
        },
      });
    }
  } catch (err) {
    console.error("handleProductUpsert error:", err);
  }
}

/* ─── products/delete ────────────────────────────────────────────────────── */

async function handleProductDelete(req, res) {
  const { id: shopifyProductId } = req.body;
  res.status(200).send("ok");

  try {
    await prisma.product.update({
      where: { shopifyProductId: String(shopifyProductId) },
      data: { status: "archived", syncedAt: new Date() },
    });
  } catch (err) {
    // P2025 = record not found — fine, nothing to delete
    if (err.code !== "P2025") console.error("handleProductDelete error:", err);
  }
}

/* ─── inventory_levels/update ───────────────────────────────────────────── */
/*
  STUB — pending a design decision. Your schema tracks availability as an
  explicitly-confirmed fact (AvailabilityState.source: SUPPLIER_CONFIRMED /
  MANUAL_OWNER / AGENT_INFERRED), not a raw Shopify stock count, and Variant
  has no quantity field to write into. Wire this up once you've decided
  whether a Shopify stock change should:
    (a) create/update an AvailabilityState with source: AGENT_INFERRED, or
    (b) just log an Event for a human/agent to act on, or
    (c) something else.
  Logging only for now so nothing breaks and nothing writes bad data.
*/
async function handleInventoryLevelUpdate(req, res) {
  const { inventory_item_id, available } = req.body;
  res.status(200).send("ok");
  console.log(
    `[shopify webhook] inventory_levels/update received — inventory_item_id=${inventory_item_id}, available=${available}. Not yet persisted (see comment in shopifyWebhookController.js).`,
  );
}

/* ─── orders/create, orders/updated ─────────────────────────────────────── */

async function handleOrderUpsert(req, res) {
  const order = req.body;
  res.status(200).send("ok");

  try {
    // Only link to a Customer if we can match one by shopifyCustomerId —
    // never create a Customer here (waPhone is required/unique and the
    // WhatsApp-driven onboarding flow owns Customer creation).
    let customerId = null;
    if (order.customer?.id) {
      const matched = await prisma.customer.findUnique({
        where: { shopifyCustomerId: String(order.customer.id) },
        select: { id: true },
      });
      customerId = matched?.id || null;
    }

    await prisma.order.upsert({
      where: { shopifyOrderId: String(order.id) },
      create: {
        shopifyOrderId: String(order.id),
        customerId,
        orderNumber: String(order.name || order.order_number || order.id),
        totalPrice: parseFloat(order.total_price || 0),
        currency: order.currency || "INR",
        financialStatus: order.financial_status || "unknown",
        fulfillmentStatus: order.fulfillment_status || null,
        lineItems: order.line_items || [],
        discountCodes: (order.discount_codes || []).map((d) => d.code),
        placedAt: order.created_at ? new Date(order.created_at) : new Date(),
      },
      update: {
        customerId,
        financialStatus: order.financial_status || "unknown",
        fulfillmentStatus: order.fulfillment_status || null,
        lineItems: order.line_items || [],
        discountCodes: (order.discount_codes || []).map((d) => d.code),
      },
    });
  } catch (err) {
    console.error("handleOrderUpsert error:", err);
  }
}

/* ─── customers/create, customers/update ────────────────────────────────── */
/*
  Customer.waPhone is required + unique, and Customer creation is owned by
  the WhatsApp onboarding flow — so this only UPDATES an existing customer
  matched by shopifyCustomerId (or by phone, backfilling shopifyCustomerId
  the first time). It never creates a new Customer row.
*/
async function handleCustomerUpsert(req, res) {
  const customer = req.body;
  res.status(200).send("ok");

  try {
    const byShopifyId = await prisma.customer.findUnique({
      where: { shopifyCustomerId: String(customer.id) },
      select: { id: true },
    });

    if (byShopifyId) {
      await prisma.customer.update({
        where: { id: byShopifyId.id },
        data: { email: customer.email || undefined, updatedAt: new Date() },
      });
      return;
    }

    const phone = customer.phone || customer.default_address?.phone;
    if (!phone) {
      console.log(
        `[shopify webhook] customer ${customer.id} has no phone — can't match to a Customer record, skipping.`,
      );
      return;
    }

    const byPhone = await prisma.customer.findUnique({
      where: { waPhone: phone },
      select: { id: true },
    });

    if (byPhone) {
      await prisma.customer.update({
        where: { id: byPhone.id },
        data: {
          shopifyCustomerId: String(customer.id),
          email: customer.email || undefined,
          updatedAt: new Date(),
        },
      });
    } else {
      console.log(
        `[shopify webhook] no existing Customer matches phone ${phone} — not creating one from Shopify data.`,
      );
    }
  } catch (err) {
    console.error("handleCustomerUpsert error:", err);
  }
}

module.exports = {
  handleProductUpsert,
  handleProductDelete,
  handleInventoryLevelUpdate,
  handleOrderUpsert,
  handleCustomerUpsert,
};
