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

function calledTool(toolCallLog, name) {
  return toolCallLog.some((c) => c.tool === name && !c.output?.error);
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
    (STOCK_CLAIM_RE.test(draftText) || PRICE_CLAIM_RE.test(draftText)) &&
    !calledTool(toolCallLog, "check_availability") &&
    !calledTool(toolCallLog, "get_product") &&
    !calledTool(toolCallLog, "search_products")
  ) {
    return { action: "block", reason: "unverified_stock_or_price_claim" };
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
