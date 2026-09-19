// src/services/agentEngine/modelRouter.js
//
// Hybrid model routing for the Sales Agent. Picks which Claude model
// serves THIS turn, using signals already computed for free (context
// phase from contextAssembler.js + a keyword scan of the customer's
// latest message) — never an extra LLM call, so routing adds zero cost
// or latency.
//
// Philosophy: default to the safer model (Sonnet) whenever a turn is
// ambiguous or could plausibly need a precise tool call. Only route to
// Haiku for turns provably low-risk — a fixed onboarding answer, or a
// plain conversational turn before any membership pitch has started.

const { env } = require("../../config/env");

const PRODUCT_INTENT_RE =
  /\b(buy|price|cost|₹|rs\.?\s?\d|stock|available|availability|search|show me|looking for|option\s?\d|go with|checkout|order|pick|choose|which one|that one|the \d(st|nd|rd|th)?|driver|iron|wedge|putter|glove|shoe|shoes|ball|balls|bag|cap|shirt|polo|trouser)\b/i;

function pickModel({ context, lastUserMessage, forceStrong = false }) {
  // Guardrail-retry turns always get the stronger model — a draft was
  // already rejected once, don't risk repeating the same mistake.
  if (forceStrong) return env.anthropicModelSonnet;

  const text = (lastUserMessage || "").toLowerCase();

  // Fixed-sequence onboarding answers (Part A) — back to Haiku. This
  // was reverted to Sonnet earlier after Haiku showed a ~37% miss rate
  // on record_profile_answer during testing, where each miss triggered
  // a full-price Sonnet repair pass. That math has changed: prompt
  // caching is now live (see toolLoop.js), so a repair pass hits a
  // cached system prompt (0.1x rate) instead of full price — the real
  // cost of an occasional miss is now much smaller than it was when
  // this was reverted. The safety net in agentEngine/index.js
  // (missedProfileAnswer check) still catches and repairs any miss
  // automatically, same as before — just cheaper now when it fires.
  if (context.enrolmentPending) return env.anthropicModelHaiku;

  // Any product/price/stock/checkout signal in the message itself.
  if (PRODUCT_INTENT_RE.test(text)) return env.anthropicModelSonnet;

  // Membership pitched (STEP 1/2 sent) but not yet enrolling, and not
  // already a member — a short reply here ("yes", "sure") is genuinely
  // ambiguous between "tell me more" and "I want to join," and the join
  // path hits the guardrail-enforced member-code-reveal rule. Keep this
  // on Sonnet.
  if (
    context.hasPitchedMembership &&
    !context.enrolmentPending &&
    !context.customer?.isMember
  ) {
    return env.anthropicModelSonnet;
  }

  // Everything else — greetings, filler acknowledgments, early browsing
  // with no product word yet, casual chat with an already-onboarded
  // member — is safe for the cheaper model.
  return env.anthropicModelHaiku;
}

module.exports = { pickModel };
