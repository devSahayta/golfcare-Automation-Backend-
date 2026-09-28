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
//
// IMPORTANT — serverless constraint: every handler awaits ALL its database
// work BEFORE calling res.send(). On Vercel, a function can be frozen or
// killed the instant a response is sent, so any code after res.send() is
// not guaranteed to finish — it can leave a Prisma connection open and
// never released, which then starves a completely unrelated later request.
// (This is exactly what caused the connection-pool-timeout errors showing
// up under /api/users instead of the webhook route itself.) Respond-fast-
// then-process-in-background is a pattern for always-on servers only;
// don't reintroduce it here.

const { prisma } = require("../lib/prisma");

function computePriceRange(variants) {
  const prices = (variants || [])
    .map((v) => parseFloat(v.price))
    .filter((p) => !Number.isNaN(p));
  if (prices.length === 0) return { priceMin: 0, priceMax: 0 };
  return { priceMin: Math.min(...prices), priceMax: Math.max(...prices) };
}

// Module 6 — category-based defaults for isConsumable/replenishDays/
// upsellPath, applied ONLY on genuine creation (never in the update
// block below — a human may deliberately change these away from the
// default later, via a bulk script or eventually a dashboard, and an
// update must never stomp that). Mirrors the one-time bulk
// classification applied to the existing catalog on 2026-09-26 — same
// categories, same target products — so a product that syncs in
// tomorrow (via a real Shopify products/create webhook, or via Module
// 5.2's supplier-onboarding approval flow, which calls this same
// function) gets treated identically to one classified in that pass,
// with no separate manual step needed.
const CONSUMABLE_REPLENISH_DAYS = {
  Balls: 50,
  "Golf Balls": 50,
  "High Visibility Balls": 50,
  Tees: 30,
  Gloves: 105,
};
const CLUB_UPSELL_TYPES = new Set([
  "Drivers", "Fairway Woods", "Hybrids", "Irons", "Iron Sets", "Individual Irons",
  "Utility Irons", "Wedges", "Putters", "Package Sets", "Individual Club",
  "Junior Individual Club", "Chippers",
]);
const UPSELL_BALL_TARGET_ID = "3cb474b6-79c2-4976-b0f2-b577f07eabfd"; // Srixon Distance Golf Balls (Pack of 12)
const UPSELL_GLOVE_TARGET_ID = "f4b8646d-8787-4aad-9227-69f8dc6771d3"; // Viper Golf Men's Tour Pro Cabretta Glove

function classifyNewProduct(productType) {
  const replenishDays = CONSUMABLE_REPLENISH_DAYS[productType];
  if (replenishDays) {
    return { isConsumable: true, replenishDays };
  }
  if (CLUB_UPSELL_TYPES.has(productType)) {
    return { upsellPath: [UPSELL_BALL_TARGET_ID, UPSELL_GLOVE_TARGET_ID] };
  }
  return {};
}

/* ─── products/create, products/update ──────────────────────────────────── */

async function handleProductUpsert(req, res) {
  const product = req.body;

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
        ...classifyNewProduct(product.product_type || null),
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

    res.status(200).send("ok");
  } catch (err) {
    console.error("handleProductUpsert error:", err);
    res.status(500).send("error");
  }
}

/* ─── products/delete ────────────────────────────────────────────────────── */

// Was previously a soft delete (status -> "archived", row kept forever).
// Changed to a real delete: a leftover archived row with no live Shopify
// counterpart is exactly what caused a real bug (module 5.2's "does this
// product already exist" check found an archived phantom row and tried
// to write availability to a Shopify variant that was 404 — confirmed by
// tracing a real write-back failure back to a leftover archived row from
// an earlier deleted test product). Nothing else in the schema references
// Product/Variant by foreign key outside of what's deleted below — Order
// stores lineItems as a Json snapshot, not a live reference, so historical
// orders are unaffected by a product being removed.
//
// Deleted explicitly, in FK-safe order, rather than relying on automatic
// cascade: SupplierProduct.variantId -> Variant has no onDelete: Cascade
// (unlike SupplierProduct.productId, AvailabilityState's two FKs, and
// Variant.productId, which all do) — letting Postgres's cascade resolve
// on its own risks a foreign key violation on that one relation.
async function handleProductDelete(req, res) {
  const { id: shopifyProductId } = req.body;

  try {
    const product = await prisma.product.findUnique({
      where: { shopifyProductId: String(shopifyProductId) },
      select: { id: true, title: true },
    });
    if (!product) {
      res.status(200).send("ok"); // never synced, or already removed — nothing to do
      return;
    }

    await prisma.availabilityLog.deleteMany({
      where: { AvailabilityState: { productId: product.id } },
    });
    await prisma.availabilityState.deleteMany({ where: { productId: product.id } });
    await prisma.supplierProduct.deleteMany({ where: { productId: product.id } });
    await prisma.variant.deleteMany({ where: { productId: product.id } });
    await prisma.product.delete({ where: { id: product.id } });

    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "product_deleted_on_shopify",
        entityType: "Product",
        entityId: product.id,
        beforeState: { title: product.title, shopifyProductId: String(shopifyProductId) },
        source: "shopify_webhook",
      },
    });

    res.status(200).send("ok");
  } catch (err) {
    console.error("handleProductDelete error:", err);
    res.status(500).send("error");
  }
}

/* ─── inventory_levels/update ───────────────────────────────────────────── */
async function handleInventoryLevelUpdate(req, res) {
  const { inventory_item_id, available } = req.body;
  console.log(
    `[shopify webhook] inventory_levels/update received — inventory_item_id=${inventory_item_id}, available=${available}. Not yet persisted (see comment in shopifyWebhookController.js).`,
  );
  res.status(200).send("ok");
}

/* ─── orders/create, orders/updated ─────────────────────────────────────── */

async function handleOrderUpsert(req, res) {
  const order = req.body;

  try {
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

    // Module 6 — deliveredAt is really "first observed fulfilled," not a
    // true carrier delivery-confirmation timestamp (we don't have carrier
    // tracking integration) — an honest approximation, but the best
    // signal available from this webhook alone. Only ever set once
    // (deliveredAt: null in the WHERE guard) so a later orders/updated
    // for the same order can't clobber the original transition time.
    if (order.fulfillment_status === "fulfilled") {
      await prisma.order.updateMany({
        where: { shopifyOrderId: String(order.id), deliveredAt: null },
        data: { deliveredAt: new Date() },
      });
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("handleOrderUpsert error:", err);
    res.status(500).send("error");
  }
}

/* ─── customers/create, customers/update ────────────────────────────────── */
async function handleCustomerUpsert(req, res) {
  const customer = req.body;

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
      res.status(200).send("ok");
      return;
    }

    const phone = customer.phone || customer.default_address?.phone;
    if (!phone) {
      console.log(
        `[shopify webhook] customer ${customer.id} has no phone — can't match to a Customer record, skipping.`,
      );
      res.status(200).send("ok");
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

    res.status(200).send("ok");
  } catch (err) {
    console.error("handleCustomerUpsert error:", err);
    res.status(500).send("error");
  }
}

module.exports = {
  handleProductUpsert,
  handleProductDelete,
  handleInventoryLevelUpdate,
  handleOrderUpsert,
  handleCustomerUpsert,
};
