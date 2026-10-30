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
const {
  maybeSendMembershipInvite,
} = require("../services/membershipInviteService");

function computePriceRange(variants) {
  const prices = (variants || [])
    .map((v) => parseFloat(v.price))
    .filter((p) => !Number.isNaN(p));
  if (prices.length === 0) return { priceMin: 0, priceMax: 0 };
  return { priceMin: Math.min(...prices), priceMax: Math.max(...prices) };
}

// Normalizes a raw phone string from Shopify into the same bare-digits,
// country-code-prefixed format already used for waPhone everywhere else in
// the system (confirmed from a real Customer row: "916382592767" — digits
// only, "91" + 10-digit number, no "+", no spaces/dashes). Shopify can hand
// back "+91 63825 92767", "+916382592767", a bare 10-digit local number, or
// occasionally a leading-0 STD-style number, depending on how the customer
// entered it at checkout — all four collapse to the same normalized form.
//
// Deliberately conservative: if the digit count doesn't match a recognizable
// Indian mobile number, this returns null rather than guessing — creating a
// Customer row with a wrong waPhone would silently break future WhatsApp
// sends to them (wrong recipient, or simply undeliverable) and would never
// self-correct, since nothing else in the system re-derives waPhone later.
function normalizePhone(raw) {
  if (!raw) {
    console.log(
      `[shopify webhook] normalizePhone called with no value (null/undefined/empty) — nothing to normalize.`,
    );
    return null;
  }
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  if (digits.length === 11 && digits.startsWith("0"))
    return `91${digits.slice(1)}`;
  console.log(
    `[shopify webhook] phone "${raw}" didn't normalize to a recognizable Indian number — skipping.`,
  );
  return null;
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
  "Drivers",
  "Fairway Woods",
  "Hybrids",
  "Irons",
  "Iron Sets",
  "Individual Irons",
  "Utility Irons",
  "Wedges",
  "Putters",
  "Package Sets",
  "Individual Club",
  "Junior Individual Club",
  "Chippers",
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
    await prisma.availabilityState.deleteMany({
      where: { productId: product.id },
    });
    await prisma.supplierProduct.deleteMany({
      where: { productId: product.id },
    });
    await prisma.variant.deleteMany({ where: { productId: product.id } });
    await prisma.product.delete({ where: { id: product.id } });

    await prisma.auditLog.create({
      data: {
        actorType: "SYSTEM",
        action: "product_deleted_on_shopify",
        entityType: "Product",
        entityId: product.id,
        beforeState: {
          title: product.title,
          shopifyProductId: String(shopifyProductId),
        },
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

/* ─── shared: resolve-or-create a Customer from a Shopify "customer" blob ── */
//
// Used by both handleOrderUpsert (fallback) and handleCustomerUpsert
// (primary path). Centralized so both handlers agree on exactly what
// counts as "the same customer" and how a brand-new one gets created —
// previously handleCustomerUpsert had its own copy of this logic and
// simply never created anything on a miss (see handleCustomerUpsert's
// comment below for why that was a real bug for website-only customers).
//
// Returns the Customer's internal id, or null if there's no usable phone
// to key off (waPhone is required + unique on the schema, so a Customer
// row can never be created without one).
async function resolveOrCreateCustomerFromShopify({
  shopifyCustomerId,
  phoneRaw,
  firstName,
  lastName,
  email,
}) {
  // 1. Already linked by shopifyCustomerId — nothing to do.
  if (shopifyCustomerId) {
    const byShopifyId = await prisma.customer.findUnique({
      where: { shopifyCustomerId: String(shopifyCustomerId) },
      select: { id: true },
    });
    if (byShopifyId) return byShopifyId.id;
  }

  const phone = normalizePhone(phoneRaw);
  if (!phone) return null;

  // 2. An existing Customer (e.g. onboarded via the WhatsApp agent) with
  //    this phone but no shopifyCustomerId yet — link it.
  const byPhone = await prisma.customer.findUnique({
    where: { waPhone: phone },
    select: { id: true, shopifyCustomerId: true },
  });
  if (byPhone) {
    if (shopifyCustomerId && !byPhone.shopifyCustomerId) {
      await prisma.customer.update({
        where: { id: byPhone.id },
        data: {
          shopifyCustomerId: String(shopifyCustomerId),
          updatedAt: new Date(),
        },
      });
    }
    return byPhone.id;
  }

  // 3. No match anywhere — this is a genuinely new, website-only customer.
  //    Create them so they're visible in the Customers table and reachable
  //    by the sales agent for follow-up, same as a WhatsApp-onboarded one.
  try {
    const created = await prisma.customer.create({
      data: {
        shopifyCustomerId: shopifyCustomerId ? String(shopifyCustomerId) : null,
        waPhone: phone,
        firstName: firstName || null,
        lastName: lastName || null,
        email: email || null,
      },
    });
    console.log(
      `[shopify webhook] created new Customer ${created.id} from Shopify data (phone ${phone}).`,
    );
    return created.id;
  } catch (err) {
    // Unique constraint race — another webhook for the same customer
    // (e.g. customers/create and orders/create arriving back-to-back)
    // created the row a moment ago. Look it up instead of failing.
    if (err.code === "P2002") {
      const retried = await prisma.customer.findUnique({
        where: { waPhone: phone },
        select: { id: true },
      });
      return retried?.id || null;
    }
    throw err;
  }
}

/* ─── orders/create, orders/updated ─────────────────────────────────────── */

// All DB work is awaited BEFORE res.send() (serverless constraint).
async function handleOrderUpsert(req, res) {
  const order = req.body;

  // Unconditional entry log — fires every time this handler runs, regardless
  // of what happens downstream, so a "nothing happened" test case is always
  // visible in the logs rather than looking identical to "handler never ran."
  console.log(
    `[shopify webhook] orders webhook received — shopifyOrderId=${order.id}, name=${order.name}, customer.id=${order.customer?.id ?? "none"}, phone candidates: customer.phone=${order.customer?.phone ?? "none"}, customer.default_address.phone=${order.customer?.default_address?.phone ?? "none"}, order.phone=${order.phone ?? "none"}, billing_address.phone=${order.billing_address?.phone ?? "none"}, shipping_address.phone=${order.shipping_address?.phone ?? "none"}`,
  );

  try {
    // Resolve the Customer from Shopify's own numeric id first (fast path,
    // works once customers/create has run for this buyer at some point).
    //
    // Fallback: Shopify does NOT guarantee orders/create arrives after
    // customers/create for the same checkout, and a guest checkout can
    // omit the customer webhook entirely — so if the id lookup misses,
    // resolve-or-create from the order's own embedded customer/contact
    // data instead. This is what makes order sync self-sufficient for a
    // pure website buyer: the order is never left permanently orphaned
    // just because another webhook didn't fire first (or at all).
    const customerId = await resolveOrCreateCustomerFromShopify({
      shopifyCustomerId: order.customer?.id || null,
      phoneRaw:
        order.customer?.phone ||
        order.customer?.default_address?.phone ||
        order.phone ||
        order.billing_address?.phone ||
        order.shipping_address?.phone ||
        null,
      firstName: order.customer?.first_name || null,
      lastName: order.customer?.last_name || null,
      email: order.customer?.email || order.email || null,
    });

    // Read the previous state so we can tell create from update, and log
    // only real changes (Shopify re-delivers webhooks).
    const existing = await prisma.order.findUnique({
      where: { shopifyOrderId: String(order.id) },
      select: { id: true, financialStatus: true, fulfillmentStatus: true },
    });

    const saved = await prisma.order.upsert({
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

    if (!existing) {
      await prisma.auditLog.create({
        data: {
          actorType: "SYSTEM",
          action: "order_created",
          entityType: "Order",
          entityId: saved.id,
          afterState: {
            orderNumber: saved.orderNumber,
            financialStatus: saved.financialStatus,
            fulfillmentStatus: saved.fulfillmentStatus,
            totalPrice: saved.totalPrice,
          },
          source: "shopify_webhook",
        },
      });

      // Roll this genuinely-new order into the linked Customer's aggregate
      // stats. Gated on `!existing` (first time THIS shopifyOrderId is
      // seen) so a webhook redelivery — orders/create retried, or
      // orders/updated arriving for the same order — never double-counts.
      // Read-then-write rather than Prisma's atomic `increment` for
      // lifetimeValue/orderCount because avgOrderValue and lastOrderAt are
      // derived from the post-update values, not simple increments.
      if (saved.customerId) {
        const customer = await prisma.customer.findUnique({
          where: { id: saved.customerId },
          select: { orderCount: true, lifetimeValue: true, lastOrderAt: true },
        });
        if (customer) {
          const newOrderCount = customer.orderCount + 1;
          const newLifetimeValue =
            Number(customer.lifetimeValue) + Number(saved.totalPrice);
          const newAvgOrderValue =
            newOrderCount > 0 ? newLifetimeValue / newOrderCount : 0;
          const newLastOrderAt =
            !customer.lastOrderAt || saved.placedAt > customer.lastOrderAt
              ? saved.placedAt
              : customer.lastOrderAt;

          const updatedCustomer = await prisma.customer.update({
            where: { id: saved.customerId },
            data: {
              orderCount: newOrderCount,
              lifetimeValue: newLifetimeValue,
              avgOrderValue: newAvgOrderValue,
              lastOrderAt: newLastOrderAt,
              updatedAt: new Date(),
            },
          });

          // NEW — real-time membership invite. A genuinely new order (this
          // whole block is inside the `!existing` branch) from a customer
          // who isn't a member yet is exactly the moment to ask: fresh off
          // an order, free program, no catch. maybeSendMembershipInvite
          // handles its own eligibility check (once ever per customer) and
          // never throws — a failure here must not turn a successful order
          // sync into a 500. updatedCustomer (not the pre-update `customer`
          // fetched above) is used so isMember/firstName reflect anything
          // this same update just changed.
          await maybeSendMembershipInvite(updatedCustomer);
        }
      }
    } else if (
      existing.financialStatus !== saved.financialStatus ||
      existing.fulfillmentStatus !== saved.fulfillmentStatus
    ) {
      await prisma.auditLog.create({
        data: {
          actorType: "SYSTEM",
          action: "order_status_changed",
          entityType: "Order",
          entityId: saved.id,
          beforeState: {
            financialStatus: existing.financialStatus,
            fulfillmentStatus: existing.fulfillmentStatus,
          },
          afterState: {
            financialStatus: saved.financialStatus,
            fulfillmentStatus: saved.fulfillmentStatus,
          },
          source: "shopify_webhook",
        },
      });
    }

    // deliveredAt = first observed fulfilled; set once only.
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

// Previously: on a miss (no existing Customer with a matching
// shopifyCustomerId OR phone), this handler just logged
// "not creating one from Shopify data" and returned 200 — meaning a
// customer who buys directly on the website and has never contacted you
// over WhatsApp was silently never added to the Customers table at all,
// and so was invisible to the sales agent for any follow-up. Now routed
// through the same resolve-or-create helper handleOrderUpsert's fallback
// uses, so this case actually creates the row.
async function handleCustomerUpsert(req, res) {
  const customer = req.body;

  console.log(
    `[shopify webhook] customers webhook received — shopifyCustomerId=${customer.id}, phone=${customer.phone ?? "none"}, default_address.phone=${customer.default_address?.phone ?? "none"}`,
  );

  try {
    const customerId = await resolveOrCreateCustomerFromShopify({
      shopifyCustomerId: customer.id,
      phoneRaw: customer.phone || customer.default_address?.phone || null,
      firstName: customer.first_name || null,
      lastName: customer.last_name || null,
      email: customer.email || null,
    });

    if (!customerId) {
      console.log(
        `[shopify webhook] customer ${customer.id} has no usable phone — can't create or match a Customer record, skipping.`,
      );
      res.status(200).send("ok");
      return;
    }

    // Keep email fresh on repeat customers/update deliveries even when no
    // create/link branch above ran (e.g. already matched by shopifyCustomerId).
    if (customer.email) {
      await prisma.customer.update({
        where: { id: customerId },
        data: { email: customer.email, updatedAt: new Date() },
      });
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
