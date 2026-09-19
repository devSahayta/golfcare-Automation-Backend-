// src/services/supplierAgent/supplierAgentTools.js
const crypto = require("crypto");
const { prisma } = require("../../lib/prisma");
const { env } = require("../../config/env");
const { setAvailability, bulkSetAvailabilityDbOnly } = require("../availabilityService");
const { createDraftProduct } = require("../shopifyProductCreate");
const { sendProductDraftApprovalEmail } = require("../emailService");
const { updateVariantPrice, updateInventoryItemCost } = require("../shopifyInventory");
const { computeCostPrice } = require("../pricingCalculator");
const { researchProductSpecs } = require("./productResearch");

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
      const newProductCandidates = []; // full item data, for the lead upsert below — see there for why

      for (const item of items) {
        const skuOrName = (item?.skuOrName || "").trim();
        const status = item?.status;
        const explicitSupplierProductId = item?.supplierProductId || null;
        if (!status || (!skuOrName && !explicitSupplierProductId)) {
          unmatched.push({
            skuOrName: skuOrName || "(blank)",
            reason: "missing_sku_or_status",
          });
          continue;
        }

        // Set once the supplier has actually picked a candidate off an
        // earlier ambiguous result — bypasses fuzzy matching entirely
        // instead of resending free text, which (confirmed live) just
        // reproduces the same ambiguous set forever for two catalog items
        // in the same brand/model family, with no way for the model to
        // ever actually apply the update.
        let match;
        if (explicitSupplierProductId) {
          const sp = catalog.find((c) => c.id === explicitSupplierProductId);
          match = sp
            ? { kind: "confident", supplierProduct: sp, label: candidateLabel(sp) }
            : { kind: "unmatched" };
        } else {
          match = matchSupplierProduct(catalog, skuOrName);
        }

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
            skuOrName: skuOrName || match.label,
            matchedProductTitle: match.label,
            status,
            ...result,
          });
          if (result.needsPricingInfo) {
            needsPricingInfo.push({ skuOrName: skuOrName || match.label, matchedProductTitle: match.label });
          }
        } else if (match.kind === "ambiguous") {
          ambiguous.push({ skuOrName, candidates: match.candidates });
        } else if (explicitSupplierProductId) {
          // An invalid/stale id, not a genuinely new product — don't spawn
          // a PendingProductLead for it, that's for real unmatched rows.
          unmatched.push({
            skuOrName: skuOrName || "(blank)",
            status,
            reason: "supplierProductId_not_found",
          });
        } else {
          unmatched.push({ skuOrName, status });
          newProductCandidates.push(item);
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

      // Record each genuinely-new item as a PendingProductLead — NOT a
      // ProductDraft yet, just a marker that this conversation still has
      // something outstanding. This is what lets the guardrail actually
      // catch the model claiming a new product is "live" without ever
      // calling create_product_draft (confirmed live: it did exactly
      // that, four times, across two replies). Skipped for the
      // too-many-to-onboard-individually case — that's handled as one
      // escalation, not per-item leads.
      if (!tooManyNewProducts) {
        for (const item of newProductCandidates) {
          await upsertPendingProductLead({
            conversationId: context.conversation.id,
            supplierId: supplier.id,
            title: item.skuOrName,
            mrp: item.mrp ?? null,
            marginPercent: item.marginPercent ?? null,
            gstPercent: item.gstPercent ?? null,
            leadTimeDays: item.leadTimeDays ?? null,
          });
        }
      }

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

      // Sequential + paced, not concurrent, for the small inline-Shopify
      // slice — confirmed live: concurrency 3 here meant up to 3 variants'
      // worth of Shopify calls in flight at once, and each variant sync is
      // itself up to 3 sequential Admin API calls, so this was really
      // bursting far more than 3 req/sec against a ~2 req/sec limit
      // ("Exceeded 2 calls per second" on 18 of 100). Any call that still
      // fails (rate limit or otherwise) now gets queued for retry too (see
      // availabilityService.js), so this doesn't need to be perfectly
      // rate-safe, just not actively hostile to it.
      const deferredTargets = primaryTargets.slice(syncCap);
      const [syncedResults] = await Promise.all([
        mapSequentialPaced(primaryTargets.slice(0, syncCap), env.shopifySyncPaceMs, (sp) =>
          setAvailability({
            variantId: sp.variantId,
            productId: sp.productId,
            status,
            source: "SUPPLIER_CONFIRMED",
            changedBy: supplier.id,
            leadTimeDays: leadTimeDays ?? null,
          }),
        ),
        // Bulk, not one setAvailability() transaction per item — confirmed
        // live this matters, not just in theory: even DB-only (no Shopify
        // call) at a conservative concurrency of 5, ~2,200 variants took
        // 22.9 minutes over a real network connection to Postgres, useless
        // for anything replying to a WhatsApp message. bulkSetAvailabilityDbOnly
        // does the same three writes (AvailabilityState, AvailabilityLog,
        // Event) as a handful of bulk queries instead of thousands of
        // individual transactions, and always queues every target for the
        // scheduler's Shopify sync.
        bulkSetAvailabilityDbOnly({
          targets: deferredTargets.map((sp) => ({ variantId: sp.variantId, productId: sp.productId })),
          status,
          source: "SUPPLIER_CONFIRMED",
          changedBy: supplier.id,
          leadTimeDays: leadTimeDays ?? null,
        }),
      ]);

      if (deferredTargets.length > 0) {
        await prisma.auditLog.create({
          data: {
            actorType: "SYSTEM",
            action: "shopify_inventory_sync_deferred_bulk_confirm",
            entityType: "SupplierCheck",
            entityId: check.id,
            afterState: {
              supplierId: supplier.id,
              status,
              deferredCount: deferredTargets.length,
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
        shopifyDeferred: deferredTargets.length,
      };
    },

    // Runs the actual web research in its OWN isolated Anthropic call (see
    // productResearch.js's header for the full reasoning) instead of the
    // model calling web_search/web_fetch directly in this conversation —
    // confirmed live that doing it inline cost 107K input tokens for one
    // product, because the raw scraped page got pulled into the same
    // context as the whole supplier conversation and resent on every
    // later iteration of that turn. Real token cost from the isolated
    // call still gets tracked (context.extraUsage — see
    // contextAssembler.js), just not paid for inside THIS conversation's
    // context.
    async research_product_specs({ title, brand }) {
      if (!title) return { error: "title_required" };
      const result = await researchProductSpecs({ title, brand });
      context.extraUsage.inputTokens += result.usage.inputTokens;
      context.extraUsage.outputTokens += result.usage.outputTokens;
      context.extraUsage.costUsd += result.cost.usd;
      context.extraUsage.costInr += result.cost.inr;
      return { specs: result.specs, imageUrl: result.imageUrl, sourceNotes: result.sourceNotes };
    },

    // Module 5.2 — a product the supplier mentioned that isn't in the
    // catalog. Creates it in Shopify as an unpublished draft immediately
    // (status: "draft"), records a ProductDraft with a single-use
    // approval token, and emails a human — never goes live on its own.
    // sourceType: "SUPPLIER_PROVIDED" (details came from the supplier) or
    // "WEB_SCRAPED" (the model used research_product_specs because the
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
        await resolvePendingProductLead({ conversationId: context.conversation.id, title, sku });
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
        await resolvePendingProductLead({ conversationId: context.conversation.id, title, sku });
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

      // Safety net, not the primary path — confirmed live that the model
      // (Haiku especially) sometimes just skips the system prompt's
      // "call research_product_specs first" instruction and drafts with
      // whatever it has (real case: PXG 0211 Iron Set got no research at
      // all). Only fires for what's actually still missing after the
      // supplier's own message and any photo — if the model already
      // researched and both specs and an image came back, this is a
      // no-op, so a model that does the right thing pays no extra cost.
      if (!specs || !resolvedImageUrl) {
        const research = await researchProductSpecs({ title, brand });
        context.extraUsage.inputTokens += research.usage.inputTokens;
        context.extraUsage.outputTokens += research.usage.outputTokens;
        context.extraUsage.costUsd += research.cost.usd;
        context.extraUsage.costInr += research.cost.inr;
        if (!specs) specs = research.specs || specs;
        if (!resolvedImageUrl) resolvedImageUrl = research.imageUrl || resolvedImageUrl;
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

      await resolvePendingProductLead({ conversationId: context.conversation.id, title, sku });
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

      // Same reasoning as the SupplierCheck close-out above — a human now
      // owns any new-product leads still open in this conversation, so
      // they shouldn't keep showing up as "still outstanding" to the
      // agent (or blocking the false-success guardrail) once escalated.
      await prisma.pendingProductLead.updateMany({
        where: { conversationId: context.conversation.id, status: "PENDING" },
        data: { status: "RESOLVED", resolvedAt: new Date() },
      });

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

// confirm_all_pending_items' pacing helper for the small inline-Shopify
// slice — one at a time, with a real delay between each. Shopify's rate
// limit is per-request, not per-variant, and each variant sync here is
// itself up to 3 sequential requests, so even bounded concurrency
// (confirmed live, at 3) still bursts several times that in requests/sec.
async function mapSequentialPaced(items, delayMs, fn) {
  const results = [];
  for (let i = 0; i < items.length; i++) {
    results.push(await fn(items[i]));
    if (i < items.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
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
  // A lone candidate at >=0.75 was always confident. Confirmed live this
  // wasn't enough: a query resent as the EXACT title of one catalog entry
  // (score 1.0) still got forced into "ambiguous" purely because a second,
  // much weaker candidate (score ~0.4-0.6, same brand/model family — e.g.
  // "Ping G430 Iron Set (6-PW)" vs. "G430 ... Steel Irons ... Stiff") also
  // cleared the 0.5 floor. The model had no way to escape that: its only
  // lever was resending the same text, which deterministically reproduced
  // the same ambiguous set every time — a real dead-end loop that, live,
  // ended with the model just fabricating a "recorded" reply instead of
  // ever actually applying the update. A decisive top score with clear
  // separation from the runner-up is exactly the "not actually ambiguous"
  // case this was meant to allow through.
  const decisiveTop =
    scored[0].score >= 0.75 &&
    (scored.length === 1 || scored[0].score - scored[1].score >= 0.25);
  if (decisiveTop) {
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

// PendingProductLead upsert/resolve — see the model's schema comment for
// why this exists (the guardrail that catches a false "created" claim
// needs to know, reliably, what's genuinely still outstanding).
//
// Exact SKU match wins outright when available — confirmed live this
// matters, not just in theory: a lead first surfaced from a supplier's
// raw sheet as skuOrName "CLV-RTX6-56" never resolved after the real
// create_product_draft call (title "Cleveland RTX 6 ZipCore Wedge 56°",
// sku "CLV-RTX6-56") succeeded, because fuzzy token overlap between "CLV"/
// "RTX6" and "Cleveland"/"RTX"/"6" as separate tokens landed under the
// 0.5 threshold — real naming variation a token-overlap heuristic alone
// doesn't handle. Falls back to fuzzy title-token overlap only when no
// exact match is available on either side.
function findLeadMatch(leads, { title, sku }) {
  const normalizedSku = (sku || "").trim().toLowerCase();
  if (normalizedSku) {
    const exact = leads.find(
      (lead) =>
        (lead.sku || "").trim().toLowerCase() === normalizedSku ||
        (lead.title || "").trim().toLowerCase() === normalizedSku,
    );
    if (exact) return exact;
  }

  const queryTokens = new Set(tokenize(title));
  if (queryTokens.size === 0) return null;
  return (
    leads.find((lead) => {
      const leadTokens = tokenize(lead.title);
      const overlap = leadTokens.filter((t) => queryTokens.has(t)).length;
      return overlap / Math.max(leadTokens.length, 1) >= 0.5;
    }) || null
  );
}

async function upsertPendingProductLead({
  conversationId,
  supplierId,
  title,
  mrp,
  marginPercent,
  gstPercent,
  leadTimeDays,
}) {
  const openLeads = await prisma.pendingProductLead.findMany({
    where: { conversationId, status: "PENDING" },
  });
  const existing = findLeadMatch(openLeads, { title });

  const data = {
    ...(mrp != null && { mrp }),
    ...(marginPercent != null && { marginPercent }),
    ...(gstPercent != null && { gstPercent }),
    ...(leadTimeDays != null && { leadTimeDays }),
  };

  if (existing) {
    await prisma.pendingProductLead.update({ where: { id: existing.id }, data });
  } else {
    // skuOrName from reconcile_stock_list is genuinely ambiguous at
    // ingestion time — could be a real name or a bare SKU (as it was
    // here) — stored as both so resolution can match on whichever one
    // create_product_draft ends up using later.
    await prisma.pendingProductLead.create({
      data: { conversationId, supplierId, title, sku: title, ...data },
    });
  }
}

async function resolvePendingProductLead({ conversationId, title, sku }) {
  const openLeads = await prisma.pendingProductLead.findMany({
    where: { conversationId, status: "PENDING" },
  });
  const match = findLeadMatch(openLeads, { title, sku });
  if (!match) return;
  await prisma.pendingProductLead.update({
    where: { id: match.id },
    data: { status: "RESOLVED", resolvedAt: new Date() },
  });
}

module.exports = { buildSupplierAgentTools };
