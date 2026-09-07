// src/services/supplierAgent/supplierGuardrails.js
//
// agentEngine/guardrails.js is Sales-Agent-specific (its own header says
// so — "give each its own guardrail rule list rather than overloading
// this one"). This is the Supplier Agent's, wired in via
// supplierAgentConfig.runGuardrails.
//
// Deliberately minimal for the check-in flow (5.1): there's no price/
// stock claim being made TO a paying customer here, so the Sales-style
// "unverified claim" checks don't apply. The meaningful guardrail
// territory for this agent — never publish a scraped spec/price without
// human approval — belongs to the not-yet-built product-onboarding flow
// (module 5.2), not this one.

function runGuardrails({ draftText, context }) {
  if (!draftText) {
    return { action: "block", reason: "no_draft_text" };
  }

  const sessionExpiresAt = context.conversation.sessionExpiresAt;
  if (sessionExpiresAt && new Date(sessionExpiresAt) < new Date()) {
    return { action: "block", reason: "session_window_expired" };
  }

  return { action: "pass" };
}

module.exports = { runGuardrails };
