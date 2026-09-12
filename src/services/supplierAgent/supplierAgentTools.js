// src/services/supplierAgent/supplierAgentTools.js
const crypto = require("crypto");
const { prisma } = require("../../lib/prisma");
const { env } = require("../../config/env");
const { setAvailability } = require("../availabilityService");
const { createDraftProduct } = require("../shopifyProductCreate");
const { sendProductDraftApprovalEmail } = require("../emailService");
const { updateVariantPrice, updateInventoryItemCost } = require("../shopifyInventory");
const { computeCostPrice } = require("../pricingCalculator");

function buildSupplierAgentTools(context) {
  const supplier = context.supplier;

  return {
    // Handles one item or many — a bare chat mention ("Ping driver is out
    // of stock") is just a one-element items array, same shape and same
    // handler as a whole sheet's worth of rows. Matching is server-side
    // (matchSupplierProduct, against this supplier's full catalog), so the
    // model never needs to know an internal id — this used to be a
    // separate confirm_availability tool keyed by an exact supplierProductId
    // "from the pending list," which broke in two ways confirmed live:
    // (1) once an item's check-in was answered it fell out of the visible
    // list, and the model reused a printed SKU as if it were the id
    // instead of recognizing it had nothing valid to call with, and (2) at
    // real catalog scale (thousands of pending items) embedding that list
    // in the system prompt every turn cost ~180K input tokens per API call.
    // Folding into this single name/SKU-matched tool removes both classes
    // of bug by construction, not just by better prompting.
    async reconcile_stock_list({ items }) {
      if (!supplier) return { error: "no_supplier_on_conversation" };
      if (!Array.isArray(items) || items.length === 0) {
        return { error: "items_required" };
      }

      const catalog = await prisma.supplierProduct.findMany({
        where: { supplierId: supplier.id },
        include: { Product: true, Variant: true },
      });

      const applied = [];
      const ambiguous = [];
      const unmatched = [];
      const needsPricingInfo = [];

      for (const item of items) {
        const skuOrName = (item?.skuOrName || "").trim();
        const status = item?.status;
        if (!skuOrName || !status) {
          unmatched.push({
            skuOrName: skuOrName || "(blank)",
            reason: "missing_sku_or_status",
          });
          continue;
        }

        const match = matchSupplierProduct(catalog, skuOrName);

        if (match.kind === "confident") {
          const result = await applyConfirmation({
            supplier,
            supplierProduct: match.supplierProduct,
            status,
            leadTimeDays: item.leadTimeDays ?? null,
            mrp: item.mrp ?? null,
            marginPercent: item.marginPercent ?? null,
            gstPercent: item.gstPercent ?? null,
          });
          applied.push({
            skuOrName,
            matchedProductTitle: match.label,
            status,
            ...result,
          });
          if (result.needsPricingInfo) {
            needsPricingInfo.push({ skuOrName, matchedProductTitle: match.label });
          }
        } else if (match.kind === "ambiguous") {
          ambiguous.push({ skuOrName, candidates: match.candidates });
        } else {
          unmatched.push({ skuOrName, status });
        }
      }

      // Backend-enforced cap on how many genuinely-new (unmatched) rows
      // get handed back for one-by-one onboarding — see env.js. Each one
      // the model tries to onboard costs a real Shopify product creation
      // and an approval email; a sheet with dozens of new rows would
      // otherwise try to create dozens of drafts (and send dozens of
      // emails) in one turn. Above the cap, the model is told to escalate
      // the whole batch instead of attempting each one.
      const tooManyNewProducts = unmatched.length > env.supplierBulkNewProductLimit;

      return {
        applied,
        ambiguous,
        unmatched: tooManyNewProducts ? [] : unmatched,
        needsPricingInfo,
        ...(tooManyNewProducts && {
          tooManyNewProducts: true,
          unmatchedCount: unmatched.length,
          guidance:
            "Too many unrecognized rows to onboard individually. Don't call create_product_draft for these — tell the supplier a human will review this batch of new products separately, and call escalate_to_human ONCE for the whole batch (not once per item).",
        }),
      };
    },

    // Backend-enforced cap, not just prompt guidance — the system prompt
    // already tells the model not to call this for a large check-in, but
    // that alone isn't reliable (confirmed live: an earlier instruction of
    // this exact shape was ignored). Refusing outright here is a hard
    // guarantee this can never re-inflate the system prompt's turn history
    // with a huge tool result, regardless of what the model decides to do.
    async list_pending_items() {
      if (!supplier) return { error: "no_supplier_on_conversation" };
      const check = await prisma.supplierCheck.findFirst({
        where: { supplierId: supplier.id, status: "SENT" },
        orderBy: { sentAt: "desc" },
      });
      const items = Array.isArray(check?.items) ? check.items : [];
      if (items.length === 0) return { error: "no_open_check_in" };

      if (items.length > env.supplierListableItemLimit) {
        return {
          error: "too_many_items_to_list",
          count: items.length,
          guidance:
            "Too many pending items to read out in a message. Tell the supplier the count and ask for a stock sheet, a blanket status (confirm_all_pending_items), or specific items by name/SKU (reconcile_stock_list).",
        };
      }

      return {
        items: items.map((item) => ({
          sku: item.sku || null,
          productTitle: item.productTitle,
          variantTitle: item.variantTitle || null,
        })),
      };
    },

    // The blanket-reply counterpart to reconcile_stock_list — one status
    // applied to every item in the currently open check-in, as a single
    // cheap backend operation instead of a giant per-item tool call.
    // Confirmed live: without this, a supplier's "all in stock" on a
    // ~2,200-item check-in made the model try to enumerate every single
    // item into reconcile_stock_list itself, which is both far more
    // expensive and can silently truncate mid-call at that size (the model
    // reported "having a technical issue submitting the full list in one
    // go" — really a hit output-token ceiling, not a real system fault).
    //
    // Every item's own SupplierProduct record gets updated regardless of
    // catalog size (a single bulk query — the real source of truth for
    // "what did this supplier last say"). AvailabilityState/Shopify sync
    // goes through the normal setAvailability() path so the DB write,
    // AvailabilityLog, and `availability.changed` event all happen the
    // usual way — but the live Shopify inventory write (2-3 Admin API
    // calls each) is only attempted inline for the first
    // bulkConfirmShopifySyncCap items, processed with bounded concurrency;
    // see env.js for why doing this inline for thousands of items isn't
    // safe to attempt in one request. Anything beyond the cap still gets
    // its DB state updated correctly, just not an inline Shopify push —
    // logged to AuditLog as deferred rather than silently dropped.
    async confirm_all_pending_items({ status, leadTimeDays }) {
      if (!supplier) return { error: "no_supplier_on_conversation" };

      const check = await prisma.supplierCheck.findFirst({
        where: { supplierId: supplier.id, status: "SENT" },
        orderBy: { sentAt: "desc" },
      });
      if (!check) return { error: "no_open_check_in" };

      const items = Array.isArray(check.items) ? check.items : [];
      const supplierProductIds = items.map((i) => i.supplierProductId).filter(Boolean);
      if (supplierProductIds.length === 0) return { error: "check_in_has_no_items" };

      const supplierProducts = await prisma.supplierProduct.findMany({
        where: { id: { in: supplierProductIds }, supplierId: supplier.id },
      });

      await prisma.supplierProduct.updateMany({
        where: { id: { in: supplierProducts.map((sp) => sp.id) } },
        data: { lastConfirmedStatus: status, lastConfirmedAt: new Date() },
      });

      // Module 2's fan-in policy: only the primary supplier's confirmation
      // drives the actual storefront-facing AvailabilityState.
      const primaryTargets = supplierProducts.filter((sp) => sp.isPrimary && sp.variantId);
      const syncCap = env.bulkConfirmShopifySyncCap;

      const [syncedResults, deferredResults] = await Promise.all([
        mapWithConcurrency(primaryTargets.slice(0, syncCap), 3, (sp) =>
          setAvailability({
            variantId: sp.variantId,
            productId: sp.productId,
            status,
            source: "SUPPLIER_CONFIRMED",
            changedBy: supplier.id,
            leadTimeDays: leadTimeDays ?? null,
          }),
        ),
        mapWithConcurrency(primaryTargets.slice(syncCap), 20, (sp) =>
          setAvailability({
            variantId: sp.variantId,
            productId: sp.productId,
            status,
            source: "SUPPLIER_CONFIRMED",
            changedBy: supplier.id,
            leadTimeDays: leadTimeDays ?? null,
            skipShopifySync: true,
          }),
        ),
      ]);

      if (deferredResults.length > 0) {
        await prisma.auditLog.create({
          data: {
            actorType: "SYSTEM",
            action: "shopify_inventory_sync_deferred_bulk_confirm",
            entityType: "SupplierCheck",
            entityId: check.id,
            afterState: {
              supplierId: supplier.id,
              status,
              deferredCount: deferredResults.length,
            },
            source: "supplier_agent",
          },
        });
      }

      await prisma.supplierCheck.update({
        where: { id: check.id },
        data: {
          status: "ANSWERED",
          respondedAt: new Date(),
          parsedBy: "supplier_agent",
          rawReplies: {
            ...(check.rawReplies || {}),
            blanketConfirmation: { status, confirmedAt: new Date().toISOString() },
          },
        },
      });

      return {
        totalItems: items.length,
        confirmedCount: supplierProducts.length,
        shopifySynced: syncedResults.length,
        shopifyDeferred: deferredResults.length,
      };
    },

    // Module 5.2 — a product the supplier mentioned that isn't in the
    // catalog. Creates it in Shopify as an unpublished draft immediately
    // (status: "draft"), records a ProductDraft with a single-use
    // approval token, and emails a human — never goes live on its own.
    // sourceType: "SUPPLIER_PROVIDED" (details came from the supplier) or
    // "WEB_SCRAPED" (the model used the web_search tool because the
    // supplier couldn't provide them — sourceNotes should say what was
    // found and where, so a reviewer isn't just trusting it blind).
    async create_product_draft({
      title,
      price,
      category,
      specs,
      brand,
      sku,
      variantOptions,
      quantity,
      status,
      marginPercent,
      gstPercent,
      sourceType,
      sourceNotes,
      imageUrl,
    }) {
      if (!supplier) return { error: "no_supplier_on_conversation" };
      if (!title || price == null) {
        return { error: "title_and_price_required" };
      }
      // Required for a brand-new product (unlike the existing-product flow,
      // where it's only asked once and then remembered — a new product has
      // nothing on file yet, so there's no "already known" to fall back on).
      if (marginPercent == null || gstPercent == null) {
        return { error: "margin_and_gst_required" };
      }
      // Confirmed for real: the model omitted this once despite it being
      // in the tool schema's `required` array (tool-call schema adherence
      // isn't 100% guaranteed) and the resulting bare Prisma error only
      // surfaced *after* the Shopify draft product had already been
      // created — leaving a real orphaned Shopify product with no
      // ProductDraft, no approval token, untraceable. Validate every
      // required field before touching Shopify at all, not after.
      if (sourceType !== "SUPPLIER_PROVIDED" && sourceType !== "WEB_SCRAPED") {
        return { error: "sourceType_required" };
      }

      // The extracted text of a whole sheet sits in conversation history
      // and can get "renoticed" by the model on a later, unrelated turn —
      // this happened for real (the same ~10-item sheet got reconciled
      // twice, 5 minutes apart, creating duplicate Shopify products every
      // time). Block on title, not on some upstream call being idempotent.
      const existingPending = await findExistingPendingDraft(supplier.id, title);
      if (existingPending) {
        return {
          error: "draft_already_exists",
          message:
            "A pending draft for this exact product already exists for this supplier — do not create another one.",
        };
      }

      // This "new product" might not be new at all — it might just be new
      // to THIS supplier's own SupplierProduct links (reconcile_stock_list
      // and confirm_availability only ever search that supplier's own
      // catalog, so anything Golf Care already stocks under no/another
      // supplier link looks "unmatched" from here). Check the real global
      // catalog before creating a duplicate Shopify product — this was a
      // real bug: a supplier restating a real, already-listed product got
      // a brand new draft product instead of a stock update.
      const catalogMatch = await findExistingCatalogMatch({ title, sku, variantOptions });
      if (catalogMatch?.variant) {
        let supplierProduct = await prisma.supplierProduct.findFirst({
          where: { supplierId: supplier.id, variantId: catalogMatch.variant.id },
        });
        if (!supplierProduct) {
          supplierProduct = await prisma.supplierProduct.create({
            data: {
              supplierId: supplier.id,
              productId: catalogMatch.product.id,
              variantId: catalogMatch.variant.id,
              supplierSku: sku || null,
              isPrimary: true, // no prior supplier link existed for this variant
            },
          });
        }
        const resolvedStatus =
          status || (quantity != null ? (quantity > 0 ? "IN_STOCK" : "OUT_OF_STOCK") : "IN_STOCK");
        const result = await applyConfirmation({
          supplier,
          supplierProduct,
          status: resolvedStatus,
          leadTimeDays: null,
          mrp: price,
          marginPercent: marginPercent ?? null,
          gstPercent: gstPercent ?? null,
        });
        return {
          productAlreadyExisted: true,
          matchedProductTitle: catalogMatch.product.title,
          message:
            "This product already exists in Golf Care's catalog — linked this supplier to it and updated its stock instead of creating a duplicate listing.",
          ...result,
        };
      }

      let resolvedImageUrl = imageUrl || null;
      if (!resolvedImageUrl && sourceType === "SUPPLIER_PROVIDED") {
        resolvedImageUrl = await getLatestInboundImageUrl(context.conversation.id);
      }

      const cleanVariantOptions = Array.isArray(variantOptions)
        ? variantOptions
            .filter((o) => o?.name && o?.value)
            .slice(0, 3)
        : [];

      let shopifyResult;
      try {
        shopifyResult = await createDraftProduct({
          title,
          price,
          category,
          specs,
          brand,
          sku,
          variantOptions: cleanVariantOptions,
          imageUrl: resolvedImageUrl,
          quantity: quantity ?? null,
        });
      } catch (err) {
        return {
          error: "shopify_creation_failed",
          detail: err.response?.data || err.message,
        };
      }

      const approvalToken = crypto.randomBytes(24).toString("hex");
      const tokenExpiresAt = new Date(
        Date.now() + env.productDraftTokenExpiryDays * 24 * 60 * 60 * 1000,
      );

      // price here is the MRP the supplier quoted — margin/GST are
      // required for a new product (validated above), so this always
      // resolves; stashed in rawPayload since there's no SupplierProduct
      // row to put it on until after approval (see productDraftController.js's
      // approveDraft, which creates that link from these exact fields).
      const costPrice = computeCostPrice({ mrp: price, marginPercent, gstPercent });

      // Best-effort, same as every other Shopify write-back — the draft
      // itself is real either way. Sets Shopify's native cost field on
      // the freshly created variant so it shows up in Shopify's own
      // margin/profit reporting immediately, not just after a later
      // price update touches it.
      const costResult = await updateInventoryItemCost(shopifyResult.shopifyVariantId, costPrice);
      if (!costResult.ok) {
        console.error(
          `[supplierAgentTools] Shopify cost sync failed for new product ${shopifyResult.shopifyProductId}:`,
          costResult.error,
        );
      }

      const draft = await prisma.productDraft.create({
        data: {
          shopifyDraftProductId: shopifyResult.shopifyProductId,
          supplierId: supplier.id,
          sourceType,
          rawPayload: {
            title,
            price,
            category: category || null,
            specs: specs || null,
            brand: brand || null,
            sku: sku || null,
            variantOptions: cleanVariantOptions,
            quantity: quantity ?? null,
            mrp: price,
            marginPercent,
            gstPercent,
            costPrice,
            imageUrl: resolvedImageUrl,
            sourceNotes: sourceNotes || null,
            supplierName: supplier.name,
          },
          approvalToken,
          tokenExpiresAt,
        },
      });

      let emailSent = false;
      try {
        const emailResult = await sendProductDraftApprovalEmail({
          token: approvalToken,
          title,
          price,
          category,
          specs,
          brand,
          sku,
          variantOptions: cleanVariantOptions,
          imageUrl: resolvedImageUrl,
          sourceType,
          supplierName: supplier.name,
        });
        await prisma.productDraft.update({
          where: { id: draft.id },
          data: { emailSentTo: emailResult.sentTo, emailSentAt: new Date() },
        });
        emailSent = true;
      } catch (err) {
        // The draft and the real Shopify product both already exist —
        // don't fail the whole tool call over a notification problem.
        // It'll just sit un-emailed until someone notices; still visible
        // via ProductDraft.emailSentAt being null.
        console.error(
          "[supplierAgentTools] product draft approval email failed:",
          err.message,
        );
      }

      return {
        draftCreated: true,
        shopifyProductId: shopifyResult.shopifyProductId,
        imageIncluded: shopifyResult.imageIncluded,
        emailSent,
      };
    },

    async escalate_to_human({ reason, urgency }) {
      // Deliberately does NOT touch Conversation.state. agentEngine gates
      // on that (only AI_HANDLING gets a response), and with no dashboard
      // yet to ever flip it back, setting AWAITING_HUMAN here meant the
      // agent went permanently silent on that conversation the moment it
      // hit anything ambiguous — which happens often (unmatched products,
      // pricing questions). Escalation should flag something for a human
      // to see later, not freeze the conversation now. A conversation
      // should only ever pause on a deliberate human action (a future
      // dashboard "take over" button), never automatically.

      // Close out the open check-in too, if there is one — otherwise it
      // sits at status SENT until the scheduler's 24h timeout sweep
      // eventually catches it, even though a human is now expected to
      // look at this sooner.
      if (supplier) {
        await prisma.supplierCheck.updateMany({
          where: { supplierId: supplier.id, status: "SENT" },
          data: { status: "ESCALATED" },
        });
      }

      await prisma.auditLog.create({
        data: {
          actorType: "AGENT",
          action: "escalated_to_human",
          entityType: "Conversation",
          entityId: context.conversation.id,
          afterState: { reason, urgency },
          source: "supplier_agent",
        },
      });
      return { escalated: true };
    },
  };
}

// Module 5.2 — a supplier's product photo arrives as a separate WhatsApp
// message from whatever text described it. Filtered on type: "image" —
// webhooks/samvaadik.js sets that explicitly when documentExtractor
// classifies an attachment as one — not just "has any mediaUrl", which
// used to also match a supplier's stock-sheet attachment (a real bug: a
// draft's imageUrl ended up pointing at the .xlsx file itself because it
// was the most recent attachment, sheet or not).
async function getLatestInboundImageUrl(conversationId) {
  const message = await prisma.message.findFirst({
    where: { conversationId, direction: "INBOUND", type: "image", mediaUrl: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  return message?.mediaUrl || null;
}

// See create_product_draft's call site — the same document staying in
// conversation history can get reprocessed by the model on a later turn;
// this is the actual guard against creating a second Shopify product for
// something already pending review.
async function findExistingPendingDraft(supplierId, title) {
  const normalizedTitle = title.trim().toLowerCase();
  const pending = await prisma.productDraft.findMany({
    where: { supplierId, approvalStatus: "PENDING" },
    select: { approvalToken: true, rawPayload: true },
  });
  return (
    pending.find(
      (d) => (d.rawPayload?.title || "").trim().toLowerCase() === normalizedTitle,
    ) || null
  );
}

// Shared by confirm_availability and reconcile_stock_list — updates the
// SupplierProduct's own record, conditionally drives AvailabilityState
// (module 2's fan-in policy: only isPrimary && variantId), handles the
// margin/GST cost-price calculation (see pricingCalculator.js) when an
// mrp is given, and closes out the open check-in's bookkeeping.
//
// Pricing behaviour: margin/GST are asked for once per SupplierProduct,
// then remembered — if they're already on file (or given again this
// call), the cost price is recomputed from the new mrp and the live
// Shopify price is updated to match (Golf Care is pure dropship — it
// doesn't set retail prices independently of suppliers). If they're
// NOT on file and weren't given, nothing is guessed: the status/leadTime
// side of the confirmation still goes through, but needsPricingInfo comes
// back true so the caller knows to ask the supplier specifically about
// this item, not the whole batch.
async function applyConfirmation({
  supplier,
  supplierProduct,
  status,
  leadTimeDays,
  mrp,
  marginPercent,
  gstPercent,
}) {
  await prisma.supplierProduct.update({
    where: { id: supplierProduct.id },
    data: {
      lastConfirmedStatus: status,
      lastConfirmedAt: new Date(),
    },
  });

  let appliedToAvailability = false;
  if (supplierProduct.isPrimary && supplierProduct.variantId) {
    await setAvailability({
      variantId: supplierProduct.variantId,
      productId: supplierProduct.productId,
      status,
      source: "SUPPLIER_CONFIRMED",
      changedBy: supplier.id,
      leadTimeDays: leadTimeDays ?? null,
    });
    appliedToAvailability = true;
  }

  await recordConfirmationOnOpenCheck({
    supplierId: supplier.id,
    supplierProductId: supplierProduct.id,
    status,
    leadTimeDays: leadTimeDays ?? null,
  });

  let pricingUpdated = false;
  let needsPricingInfo = false;
  if (mrp != null) {
    const resolvedMargin =
      marginPercent != null ? marginPercent : numberOrNull(supplierProduct.marginPercent);
    const resolvedGst =
      gstPercent != null ? gstPercent : numberOrNull(supplierProduct.gstPercent);

    if (resolvedMargin != null && resolvedGst != null) {
      const costPrice = computeCostPrice({
        mrp,
        marginPercent: resolvedMargin,
        gstPercent: resolvedGst,
      });
      await prisma.supplierProduct.update({
        where: { id: supplierProduct.id },
        data: { costPrice, marginPercent: resolvedMargin, gstPercent: resolvedGst },
      });

      if (supplierProduct.variantId) {
        const variant = await prisma.variant.findUnique({
          where: { id: supplierProduct.variantId },
          select: { shopifyVariantId: true },
        });
        if (variant) {
          const [priceResult, costResult] = await Promise.all([
            updateVariantPrice(variant.shopifyVariantId, mrp),
            updateInventoryItemCost(variant.shopifyVariantId, costPrice),
          ]);
          if (!priceResult.ok) {
            console.error(
              `[supplierAgentTools] Shopify price sync failed for variant ${supplierProduct.variantId}:`,
              priceResult.error,
            );
            await prisma.auditLog.create({
              data: {
                actorType: "SYSTEM",
                action: "shopify_price_sync_failed",
                entityType: "Variant",
                entityId: supplierProduct.variantId,
                afterState: { mrp, error: priceResult.error },
                source: "supplier_agent",
              },
            });
          }
          if (!costResult.ok) {
            console.error(
              `[supplierAgentTools] Shopify cost sync failed for variant ${supplierProduct.variantId}:`,
              costResult.error,
            );
            await prisma.auditLog.create({
              data: {
                actorType: "SYSTEM",
                action: "shopify_cost_sync_failed",
                entityType: "Variant",
                entityId: supplierProduct.variantId,
                afterState: { costPrice, error: costResult.error },
                source: "supplier_agent",
              },
            });
          }
        }
      }
      pricingUpdated = true;
    } else {
      needsPricingInfo = true;
    }
  }

  return { appliedToAvailability, pricingUpdated, needsPricingInfo };
}

function numberOrNull(value) {
  return value == null ? null : Number(value);
}

// confirm_all_pending_items' bulk-apply helper — runs `fn` over `items`
// with at most `limit` in flight at once. A plain Promise.all would fire
// every item's setAvailability() (each its own DB transaction, and
// sometimes several Shopify API calls) all at the same instant; bounded
// concurrency keeps that from hammering Postgres/Shopify at real catalog
// scale while still being far faster than a fully sequential loop.
async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// --- reconcile_stock_list matching (v1 heuristic — see the note on
// search_products in salesAgentTools.js; same "no embedding pipeline
// decided yet" situation applies here) ---
//
// Exact SKU match (against either the supplier's own SKU or Shopify's
// variant SKU) wins outright. Otherwise, normalized-token overlap against
// the product/variant title: a single confident candidate (>=75% of the
// query's tokens covered) auto-applies; anything else plausible (>=50%,
// or more than one candidate at any score) comes back "ambiguous" so the
// agent asks rather than guesses, per the same principle already in its
// system prompt.
const STOPWORDS = new Set([
  "the", "and", "for", "with", "size", "have", "any", "golf", "set", "of",
]);

function normalizeSku(s) {
  return (s || "").toLowerCase().trim();
}

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

function candidateLabel(sp) {
  return sp.Variant?.title
    ? `${sp.Product.title} (${sp.Variant.title})`
    : sp.Product.title;
}

function matchSupplierProduct(catalog, query) {
  const normalizedQuery = normalizeSku(query);
  const exactSkuMatches = catalog.filter((sp) => {
    const skus = [sp.supplierSku, sp.Variant?.sku].filter(Boolean).map(normalizeSku);
    return skus.includes(normalizedQuery);
  });
  if (exactSkuMatches.length === 1) {
    return {
      kind: "confident",
      supplierProduct: exactSkuMatches[0],
      label: candidateLabel(exactSkuMatches[0]),
    };
  }
  if (exactSkuMatches.length > 1) {
    return {
      kind: "ambiguous",
      candidates: exactSkuMatches.map((sp) => ({
        supplierProductId: sp.id,
        title: candidateLabel(sp),
      })),
    };
  }

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return { kind: "unmatched" };

  const scored = catalog
    .map((sp) => {
      const candidateTokens = new Set(tokenize(candidateLabel(sp)));
      const overlap = queryTokens.filter((t) => candidateTokens.has(t)).length;
      return { sp, score: overlap / queryTokens.length };
    })
    .filter((s) => s.score >= 0.5)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: "unmatched" };
  if (scored.length === 1 && scored[0].score >= 0.75) {
    return {
      kind: "confident",
      supplierProduct: scored[0].sp,
      label: candidateLabel(scored[0].sp),
    };
  }
  return {
    kind: "ambiguous",
    candidates: scored
      .slice(0, 3)
      .map((s) => ({ supplierProductId: s.sp.id, title: candidateLabel(s.sp) })),
  };
}

// create_product_draft's real-product-already-exists check — deliberately
// separate from matchSupplierProduct above, which only searches THIS
// supplier's own SupplierProduct links. This searches Golf Care's whole
// catalog (every Product/Variant, regardless of supplier), because a
// product being "unmatched" against one supplier's links says nothing
// about whether it's genuinely new to Golf Care.
//
// Deliberately conservative: only returns a match when both the product
// AND a specific variant are confidently identified. A wrong auto-link
// (applying a stock update to the wrong SKU) is worse than occasionally
// falling through to create a duplicate draft a human then has to notice
// and reject — asymmetric risk, so this errs toward "no match" whenever
// there's real ambiguity, rather than trying to disambiguate on its own.
async function findExistingCatalogMatch({ title, sku, variantOptions }) {
  // status: "active" only — handleProductDelete (shopifyWebhookController.js)
  // soft-deletes: a product removed on Shopify gets status flipped to
  // "archived" here, the row is never actually removed (so order history
  // etc. stays intact). Without this filter, a deleted-on-Shopify product
  // still sitting in our table (archived, or "draft" pending its own
  // approval) would look like a legitimate "this already exists" match —
  // confirmed for real: a test product's archived leftover row got
  // auto-linked to a supplier and its 404-on-Shopify variant "confirmed,"
  // exactly the write-back failure this filter prevents from recurring.
  if (sku) {
    const bySku = await prisma.variant.findFirst({
      where: { sku: { equals: sku, mode: "insensitive" }, Product: { status: "active" } },
      include: { Product: true },
    });
    if (bySku) return { product: bySku.Product, variant: bySku };
  }

  const titleTokens = tokenize(title);
  if (titleTokens.length === 0) return null;

  const candidates = await prisma.product.findMany({
    where: {
      status: "active",
      OR: titleTokens.slice(0, 6).map((w) => ({ title: { contains: w, mode: "insensitive" } })),
    },
    include: { Variant: true },
    take: 15,
  });
  if (candidates.length === 0) return null;

  const scored = candidates
    .map((p) => {
      const candidateTokens = new Set(tokenize(p.title));
      const overlap = titleTokens.filter((t) => candidateTokens.has(t)).length;
      return { product: p, score: overlap / titleTokens.length };
    })
    .filter((s) => s.score >= 0.6)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  // Require a clearly dominant top match, not just the highest of several
  // similar scores — same "don't guess" reasoning as matchSupplierProduct.
  if (scored.length > 1 && scored[1].score >= scored[0].score - 0.15) return null;

  const product = scored[0].product;
  if (product.Variant.length === 0) return null;
  if (product.Variant.length === 1) return { product, variant: product.Variant[0] };

  const optionTokens = (variantOptions || []).flatMap((o) => tokenize(o.value));
  if (optionTokens.length === 0) return null; // multiple variants, nothing to disambiguate with

  const variantScored = product.Variant.map((v) => {
    const vTokens = new Set(tokenize(v.title));
    const overlap = optionTokens.filter((t) => vTokens.has(t)).length;
    return { variant: v, score: overlap / optionTokens.length };
  }).sort((a, b) => b.score - a.score);

  if (variantScored[0].score < 0.5) return null;
  if (variantScored.length > 1 && variantScored[1].score >= variantScored[0].score) return null;

  return { product, variant: variantScored[0].variant };
}

// Appends this confirmation to the currently-open SupplierCheck's
// rawReplies, and flips it to ANSWERED once every item in `items` has a
// matching confirmation. Re-reads the check fresh rather than trusting
// context.pendingCheck, since a supplier can confirm several items across
// several tool calls within the same turn.
async function recordConfirmationOnOpenCheck({
  supplierId,
  supplierProductId,
  status,
  leadTimeDays,
}) {
  const check = await prisma.supplierCheck.findFirst({
    where: { supplierId, status: "SENT" },
    orderBy: { sentAt: "desc" },
  });
  if (!check) return; // e.g. supplier volunteering a status update outside any open check-in

  const rawReplies = check.rawReplies || {};
  const confirmations = Array.isArray(rawReplies.confirmations)
    ? rawReplies.confirmations.filter(
        (c) => c.supplierProductId !== supplierProductId,
      )
    : [];
  confirmations.push({
    supplierProductId,
    status,
    leadTimeDays,
    confirmedAt: new Date().toISOString(),
  });

  const items = Array.isArray(check.items) ? check.items : [];
  const allConfirmed =
    items.length > 0 &&
    items.every((item) =>
      confirmations.some(
        (c) => c.supplierProductId === item.supplierProductId,
      ),
    );

  await prisma.supplierCheck.update({
    where: { id: check.id },
    data: {
      rawReplies: { ...rawReplies, confirmations },
      parsedBy: "supplier_agent",
      ...(allConfirmed && { status: "ANSWERED", respondedAt: new Date() }),
    },
  });
}

module.exports = { buildSupplierAgentTools };
