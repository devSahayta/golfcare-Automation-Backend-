// src/services/agentEngine/modelPricing.js
//
// Single source of truth for per-model Anthropic pricing — used by
// agentEngine/index.js (the main conversation's cost, priced at whatever
// model modelRouter.js picked for that turn) AND
// supplierAgent/productResearch.js (its isolated research call). Split out
// specifically so those never compute cost from two different,
// silently-drifting copies of the same rate table — confirmed live once
// already that a stale/mismatched rate silently understates real cost (a
// Sonnet conversation got logged at Haiku's rate after a model switch left
// an old hardcoded constant behind).
//
// Also holds the per-model REQUEST settings that differ between model
// generations (requestOptionsFor below), so toolLoop.js and every direct
// messages.create caller get them from one place.
//
// USD_TO_INR is a rough static rate, not fetched live — good enough for a
// ballpark next to the real, exact token counts, not intended as a
// billing-accurate conversion.

// USD per million tokens.
const MODEL_PRICING_USD_PER_MTOK = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  // Haiku 5.5's rate when the prompt is 100K tokens or fewer — every call
  // this app makes is well under that (the long-prompt card, $0.50/$2.50,
  // only applies above 100K).
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};
const DEFAULT_PRICING = MODEL_PRICING_USD_PER_MTOK["claude-sonnet-4-6"];
const USD_TO_INR = 95;
// Billed separately from tokens: $10 per 1,000 web searches.
const WEB_SEARCH_USD_EACH = 0.01;

function getPricing(model) {
  return MODEL_PRICING_USD_PER_MTOK[model] || DEFAULT_PRICING;
}

/**
 * @param {string} model
 * @param {{inputTokens: number, outputTokens: number, cacheCreationTokens?: number, cacheReadTokens?: number, webSearches?: number}} usage
 * @returns {{usd: number, inr: number}}
 */
function computeCost(model, usage) {
  if (!usage) return { usd: 0, inr: 0 };
  const pricing = getPricing(model);
  const usd =
    (usage.inputTokens / 1_000_000) * pricing.input +
    (usage.outputTokens / 1_000_000) * pricing.output +
    // cache writes bill at 1.25x input, cache reads at 0.1x input
    ((usage.cacheCreationTokens || 0) / 1_000_000) * pricing.input * 1.25 +
    ((usage.cacheReadTokens || 0) / 1_000_000) * pricing.input * 0.1 +
    (usage.webSearches || 0) * WEB_SEARCH_USD_EACH;
  return { usd, inr: usd * USD_TO_INR };
}

// Sonnet 5.5 / Haiku 5.5 think by default, and thinking counts toward
// max_tokens even though its text isn't returned — so they need headroom
// above the answer's own size, or a reply gets cut off mid-sentence.
// Only tokens actually generated are billed, so the higher cap itself
// costs nothing.
function thinksByDefault(model) {
  return model === "claude-haiku-5-5" || model === "claude-sonnet-5-5";
}

/**
 * Request fields that depend on the model generation.
 * @param {string} model
 * @param {{answerTokens: number, effort?: "low"|"medium"|"high"}} opts
 *   answerTokens: the cap the reply itself needs (what max_tokens was
 *   before these models). effort: how much the newer models think —
 *   omitted means the model's default ("medium" on Haiku 5.5).
 * @returns {{max_tokens: number, output_config?: {effort: string}}}
 */
function requestOptionsFor(model, { answerTokens, effort }) {
  if (!thinksByDefault(model)) return { max_tokens: answerTokens };
  return {
    max_tokens: answerTokens + 4096,
    ...(effort ? { output_config: { effort } } : {}),
  };
}

module.exports = {
  MODEL_PRICING_USD_PER_MTOK,
  getPricing,
  computeCost,
  requestOptionsFor,
  USD_TO_INR,
};
