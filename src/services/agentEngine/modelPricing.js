// src/services/agentEngine/modelPricing.js
//
// Single source of truth for per-model Anthropic pricing — used by
// agentEngine/index.js (the main conversation's cost, priced at whatever
// env.anthropicModel currently is) AND supplierAgent/productResearch.js
// (its isolated research call, deliberately pinned to a specific model
// regardless of what the main conversation uses). Split out specifically
// so those two never compute cost from two different, silently-drifting
// copies of the same rate table — confirmed live once already that a
// stale/mismatched rate silently understates real cost (a Sonnet
// conversation got logged at Haiku's rate after a model switch left an
// old hardcoded constant behind).
//
// USD_TO_INR is a rough static rate, not fetched live — good enough for a
// ballpark next to the real, exact token counts, not intended as a
// billing-accurate conversion.
const MODEL_PRICING_USD_PER_MTOK = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};
const DEFAULT_PRICING = MODEL_PRICING_USD_PER_MTOK["claude-sonnet-4-6"];
const USD_TO_INR = 95;

function getPricing(model) {
  return MODEL_PRICING_USD_PER_MTOK[model] || DEFAULT_PRICING;
}

/**
 * @param {string} model
 * @param {{inputTokens: number, outputTokens: number}} usage
 * @returns {{usd: number, inr: number}}
 */
function computeCost(model, usage) {
  if (!usage) return { usd: 0, inr: 0 };
  const pricing = getPricing(model);
  const usd =
    (usage.inputTokens / 1_000_000) * pricing.input +
    (usage.outputTokens / 1_000_000) * pricing.output;
  return { usd, inr: usd * USD_TO_INR };
}

module.exports = { MODEL_PRICING_USD_PER_MTOK, getPricing, computeCost, USD_TO_INR };
