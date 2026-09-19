// src/services/agentEngine/guardrails.js
//
// Runs after the tool loop, before send. Each rule can only block for now
// (no auto-rewrite yet — safer to escalate to a human than to have the
// engine silently rewrite what the model said). Rules read the tool call
// log to check claims are actually backed by data, not just plausible
// text. This file is Sales-Agent-specific today (the rules reference
// Sales tools by name); when Supplier/Lifecycle agents are built, give
// each its own guardrail rule list rather than overloading this one.

const { env } = require("../../config/env");

const STOCK_CLAIM_RE = /\b(in stock|out of stock|available|sold out)\b/i;

// Catches hallucinated/reconstructed URLs — the model has seen "golfcare.in"
// in its own persona description and can invent plausible-looking links
// using that domain instead of copying the real productUrl from tool
// output. Any http(s) link in the reply must point to the actual live
// domain; anything else is treated the same as an unverified price claim.
const URL_RE = /https?:\/\/([^\/\s]+)/gi;
function hasHallucinatedDomain(draftText) {
  const allowedDomain =
    process.env.SHOPIFY_SHOP_DOMAIN || "y3tzk0-4d.myshopify.com";
  const matches = [...draftText.matchAll(URL_RE)];
  return matches.some(
    (m) => m[1].toLowerCase() !== allowedDomain.toLowerCase(),
  );
}

// NEW — catches internal tool-output plumbing leaking straight into the
// customer-facing message. Confirmed in production: a reply that opened
// with "I see the results came back with `orientationRelaxed: true`,
// which means the catalog doesn't separately tag right-hand as a
// filter..." — the model narrating its own tool schema/field names to
// the customer instead of just using the information silently. This is
// not a phrasing nuance to leave to prompt instructions alone (same
// class of thing as hasHallucinatedDomain above) — a customer should
// never see a raw field name, boolean, or internal reasoning-about-the-
// tool-output in their message, regardless of how the surrounding
// sentence is worded. Field names are the actual JSON keys returned by
// search_products (see salesAgentTools.js) plus a few generic internal-
// sounding terms; deliberately NOT blocking on words like "variant" or
// "available" alone since those are normal English a human agent would
// also say.
const INTERNAL_JARGON_RE =
  /\b(orientationRelaxed|colorRelaxed|vendorRelaxed|moreAvailable|totalCount|variantId|productId|toolCalls|tool_use|tool_result|AGENT_INFERRED|SUPPLIER_CONFIRMED|MANUAL_OWNER)\b|`[a-zA-Z]+Relaxed`|\bthe results came back with\b/i;
function leaksInternalJargon(draftText) {
  return INTERNAL_JARGON_RE.test(draftText);
}

// NEW — catches a record_profile_answer call whose answer text has no
// traceable connection to what the customer actually said this turn.
// Confirmed in testing: during enrolment, the model recorded a fake
// homeClub answer ("Bangalore Golf Club") the customer never mentioned,
// one question ahead of what was actually asked — the customer had only
// answered firstName. Since the tool call genuinely succeeds (it's not
// a missing call), this needs its own check: for every
// record_profile_answer call in the log, the answer text must appear
// (loosely) in the customer's own most recent message. A field the
// model invents whole-cloth won't have any overlap with what the
// customer actually typed.
function normalizeForOverlapCheck(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .trim();
}

// Only checked for genuinely free-text fields where a fabricated answer
// is possible and would be a real, novel fact the model invented —
// firstName and homeClub are the fields this was actually built to
// catch (confirmed: a fabricated "Bangalore Golf Club" homeClub
// answer). Fields with mapper functions in enrolmentQuestions.js
// (skillLevel, playFrequency, gloveHand, marketingConsent) are
// EXCLUDED — those are meant to be normalized/paraphrased from the
// customer's raw words ("yea ok" -> "yes", "weekly once" -> "weekly"),
// and applying literal word-overlap there produces false positives on
// completely correct interpretations, which is what happened in
// testing ("Yea ok" -> recorded "yes" got wrongly flagged as
// hallucinated). gloveSize and currentBallModel are borderline free
// text but low fabrication risk in practice, left out for now — add
// back in if a real fabrication is observed there.
const FREE_TEXT_FIELDS_TO_CHECK = new Set(["firstName", "homeClub"]);

function hasHallucinatedProfileAnswer(toolCallLog, context) {
  const recordCalls = toolCallLog.filter(
    (c) =>
      c.tool === "record_profile_answer" &&
      !c.output?.error &&
      FREE_TEXT_FIELDS_TO_CHECK.has(c.input?.fieldKey),
  );
  if (!recordCalls.length) return false;

  const lastCustomerMsg = [...(context.recentMessages || [])]
    .reverse()
    .find((m) => m.sender === "CUSTOMER");
  const customerText = normalizeForOverlapCheck(lastCustomerMsg?.body);
  if (!customerText) return false;

  return recordCalls.some((call) => {
    const answer = normalizeForOverlapCheck(call.input?.answer);
    if (!answer) return false;
    const answerWords = answer.split(/\s+/).filter((w) => w.length > 1);
    if (!answerWords.length) return false;
    return !answerWords.some((w) => customerText.includes(w));
  });
}

// NEW — catches a get_product/check_availability/create_checkout_link
// call using a productId/variantId that was never actually returned by
// a search_products or get_product call earlier in this turn or in
// recent history. Confirmed in testing: Haiku called check_availability
// with a fabricated variantId that appeared nowhere in the
// conversation's real tool results — the real ID from a prior search
// was available but not used. This is dangerous specifically because
// check_availability doesn't error on an unknown ID, it just returns
// UNKNOWN, making the mistake indistinguishable from a real
// out-of-stock item to both the model and the customer.
const ID_LOOKUP_TOOLS = [
  "get_product",
  "check_availability",
  "create_checkout_link",
];

function collectKnownIds(toolCallLog, recentMessages) {
  const ids = new Set();
  const scanResult = (output) => {
    if (!output) return;
    if (Array.isArray(output.results)) {
      output.results.forEach((r) => {
        if (r.productId) ids.add(r.productId);
        (r.variants || []).forEach((v) => v.variantId && ids.add(v.variantId));
      });
    }
    if (output.product?.id) ids.add(output.product.id);
    if (output.variant?.id) ids.add(output.variant.id);
    if (Array.isArray(output.product?.Variant)) {
      output.product.Variant.forEach((v) => v.id && ids.add(v.id));
    }
  };
  toolCallLog.forEach((c) => {
    if (["search_products", "get_product"].includes(c.tool))
      scanResult(c.output);
  });
  (recentMessages || []).forEach((m) => {
    (m.toolCalls || []).forEach((c) => {
      if (["search_products", "get_product"].includes(c.tool))
        scanResult(c.output);
    });
  });
  return ids;
}

function hasFabricatedId(toolCallLog, context) {
  const idLookupCalls = toolCallLog.filter(
    (c) =>
      ID_LOOKUP_TOOLS.includes(c.tool) &&
      (c.input?.productId || c.input?.variantId),
  );
  if (!idLookupCalls.length) return false;

  const knownIds = collectKnownIds(toolCallLog, context.recentMessages);
  if (!knownIds.size) return false; // nothing to cross-check against yet, don't false-positive on turn 1

  return idLookupCalls.some((c) => {
    const usedId = c.input?.productId || c.input?.variantId;
    return usedId && !knownIds.has(usedId);
  });
}

const PRICE_CLAIM_RE = /₹\s?[\d,]+/;
const DISCOUNT_RE = /(\d+)\s?%\s?(off|discount)/i;
const MEMBERSHIP_CLAIM_RE =
  /you'?re (now )?a member|membership (is )?active|enrolled you/i;

// Heuristic for "this response is recommending/describing specific products":
// *bold*-style segments (WhatsApp formatting for product names) with no
// product lookup this turn OR earlier in the visible conversation history.
// Checking history (not just this turn) matters — a recap/pitch turn that
// references a product verified two turns ago shouldn't be treated as a
// fresh hallucination.
const BOLD_SEGMENT_RE = /\*[^*\n]+\*/g;

// A member code (GCXXXXXX format) is legitimately bold in completion
// messages, but it isn't a "product name" — without this exclusion, any
// message that both reveals the code AND mentions "in stock" generically
// (e.g. "we'll keep your usual in stock") gets falsely flagged as an
// unverified product claim purely because *some* bold text exists,
// regardless of what that bold text actually is.
const MEMBER_CODE_RE = /^GC[A-Z0-9]{6}$/;
function countsAsProductBoldSegment(segment) {
  const inner = segment.slice(1, -1).trim(); // strip the surrounding asterisks
  return !MEMBER_CODE_RE.test(inner);
}
function productBoldSegments(draftText) {
  return (draftText.match(BOLD_SEGMENT_RE) || []).filter(
    countsAsProductBoldSegment,
  );
}
const PRODUCT_LOOKUP_TOOLS = [
  "search_products",
  "get_product",
  "create_checkout_link",
];

function calledTool(toolCallLog, name) {
  return toolCallLog.some((c) => c.tool === name && !c.output?.error);
}

function calledToolInHistory(recentMessages, names) {
  return (recentMessages || []).some(
    (m) =>
      Array.isArray(m.toolCalls) &&
      m.toolCalls.some((c) => names.includes(c.tool) && !c.output?.error),
  );
}

function calledAnyProductLookup(toolCallLog, recentMessages) {
  return (
    PRODUCT_LOOKUP_TOOLS.some((name) => calledTool(toolCallLog, name)) ||
    calledToolInHistory(recentMessages, PRODUCT_LOOKUP_TOOLS)
  );
}

// Catches the model recommending plausible-sounding but unverified product
// names — two or more bold segments AND at least one price figure, with no
// product lookup anywhere in scope (this turn or recent history). Requiring
// a price alongside the bold text matters: a normal clarifying question
// ("carry bag, cart bag, or tour bag?") legitimately uses bold category
// words with zero prices and zero risk — it isn't asserting anything a
// search would need to verify, so it shouldn't be treated the same as an
// invented product+price list.
function looksLikeUnverifiedProductList(
  draftText,
  toolCallLog,
  recentMessages,
) {
  if (calledAnyProductLookup(toolCallLog, recentMessages)) return false;
  const boldSegments = productBoldSegments(draftText);
  const hasPriceMarker = PRICE_CLAIM_RE.test(draftText);
  return boldSegments.length >= 2 && hasPriceMarker;
}

// Hard backstop for the member-code-reveal ordering, independent of
// whether the model follows its prompt instructions correctly. The code
// can only legitimately appear in a reply if record_profile_answer just
// returned enrolmentCompleted:true THIS turn (the deterministic
// all-7-fields check in salesAgentTools.js), or the customer was already
// a fully onboarded member before this turn even started.
function revealsMemberCode(draftText, context) {
  const code = context.customer?.memberCode;
  if (!code) return false;
  return draftText.includes(code);
}

function enrolmentJustCompleted(toolCallLog) {
  return toolCallLog.some(
    (c) =>
      c.tool === "record_profile_answer" &&
      c.output?.enrolmentCompleted === true,
  );
}

function lastCheckoutTotal(toolCallLog) {
  const call = [...toolCallLog]
    .reverse()
    .find((c) => c.tool === "create_checkout_link");
  return call?.output?.totalInr || 0;
}

function runGuardrails({ draftText, toolCallLog, context }) {
  if (!draftText) {
    return { action: "block", reason: "no_draft_text" };
  }

  // Meta's 24h free-text window — outside it, only template sends are
  // allowed. The agent has no template-send tool yet, so block and
  // escalate rather than silently fail a WhatsApp send.
  const sessionExpiresAt = context.conversation.sessionExpiresAt;
  if (sessionExpiresAt && new Date(sessionExpiresAt) < new Date()) {
    return { action: "block", reason: "session_window_expired" };
  }

  if (hasHallucinatedDomain(draftText)) {
    return { action: "block", reason: "hallucinated_url_domain" };
  }

  if (leaksInternalJargon(draftText)) {
    return { action: "block", reason: "internal_jargon_leak" };
  }

  if (hasHallucinatedProfileAnswer(toolCallLog, context)) {
    return { action: "block", reason: "hallucinated_profile_answer" };
  }

  if (hasFabricatedId(toolCallLog, context)) {
    return { action: "block", reason: "fabricated_product_id" };
  }

  if (
    looksLikeUnverifiedProductList(
      draftText,
      toolCallLog,
      context.recentMessages,
    )
  ) {
    return { action: "block", reason: "unverified_product_names" };
  }

  // Stock/price claims only count as product claims when a specific
  // product is actually named (bolded) alongside them — "we'll keep your
  // usual in stock for you" is a generic service line, not a claim about
  // any particular item's current availability, and shouldn't need a
  // tool call to back it up.
  const hasBoldProductRef = productBoldSegments(draftText).length >= 1;
  if (
    (STOCK_CLAIM_RE.test(draftText) || PRICE_CLAIM_RE.test(draftText)) &&
    hasBoldProductRef &&
    !calledTool(toolCallLog, "check_availability") &&
    !calledAnyProductLookup(toolCallLog, context.recentMessages)
  ) {
    return { action: "block", reason: "unverified_stock_or_price_claim" };
  }

  if (revealsMemberCode(draftText, context)) {
    const alreadyFullyOnboarded =
      context.customer?.onboardingState === "COMPLETED";
    if (!alreadyFullyOnboarded && !enrolmentJustCompleted(toolCallLog)) {
      return { action: "block", reason: "premature_member_code_reveal" };
    }
  }

  const discountMatch = draftText.match(DISCOUNT_RE);
  if (discountMatch && Number(discountMatch[1]) > env.discountCeilingPercent) {
    return { action: "block", reason: "discount_above_ceiling" };
  }

  const checkoutTotal = lastCheckoutTotal(toolCallLog);
  if (
    checkoutTotal > env.handoverValueThresholdInr &&
    !calledTool(toolCallLog, "escalate_to_human")
  ) {
    return { action: "block", reason: "handover_threshold_breached" };
  }

  if (
    MEMBERSHIP_CLAIM_RE.test(draftText) &&
    !calledTool(toolCallLog, "enroll_membership")
  ) {
    return { action: "block", reason: "unverified_membership_claim" };
  }

  return { action: "pass" };
}

module.exports = { runGuardrails };
