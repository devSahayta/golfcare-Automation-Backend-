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
// names — two or more bold segments with no product lookup anywhere in
// scope (this turn or recent history).
function looksLikeUnverifiedProductList(
  draftText,
  toolCallLog,
  recentMessages,
) {
  if (calledAnyProductLookup(toolCallLog, recentMessages)) return false;
  const boldSegments = draftText.match(BOLD_SEGMENT_RE) || [];
  return boldSegments.length >= 2;
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
  const hasBoldProductRef =
    (draftText.match(BOLD_SEGMENT_RE) || []).length >= 1;
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
