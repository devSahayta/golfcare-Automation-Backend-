// src/services/pricingEngine/pricingConfigLoader.js
//
// Assembles computeEnvelope's nested config shape from the flat
// PricingConfig rows (one row per §3 key, see scripts/seedPricingConfig.js).
// Deliberately falls back to the spec's own defaults for any row that's
// missing — a config key someone accidentally deletes from the table
// should never crash pricing or silently zero out a discount; it should
// just behave as if nobody had touched that setting.
//
// NOTE: no lever.aged / lever.overstock / lever.scarce.maxQty here —
// Golf Care is pure dropship (see computeEnvelope.js's header comment),
// so those rows exist in the table (kept intentionally, not deleted —
// Tejas's call) but are never read by the engine or this loader.
//
// Phase 5 addition: assembleConfig(flat) is pulled out of loadPricingConfig
// below (same "one place this logic lives" move as computeFloorPrice was
// pulled out of computeEnvelope in Phase 4) so pricingConfigController's
// preview endpoint can assemble a "proposed" nested config from a flat
// object with one or two keys overridden, without duplicating this
// flat-to-nested mapping a second time somewhere else.

const { prisma } = require("../../lib/prisma");

const DEFAULTS = {
  "member.basePct": 10,
  "member.floorMode": "margin_wins",
  "margin.bandThreshold": 100000,
  "margin.minBelow": 0.25,
  "margin.minAbove": 0.15,
  "margin.smoothing.enabled": false,
  "margin.smoothing.minProfit": 25000,
  "ceiling.maxTotalPct": 25,
  "lever.richMargin": { minListMargin: 0.45, pct: 2 },
  "lever.oldModel.pct": 5,
  "lever.offSeason": { months: [4, 9], pct: 2 },
  "lever.tier": { STANDARD: 0, SILVER: 2, GOLD: 3, PLATINUM: 5 },
  "lever.ltv": { topPercentile: 10, pct: 2 },
  "lever.bundle": { minItems: 2, minOrderValue: 10000, pct: 2 },
  "ladder.steps": [0.4, 0.75, 1.0],
  "ladder.thinRoom": { minRupees: 200, minPct: 2 },
  "agent.maxOrderForLevers": 40000,
  "offer.validityHours": 48,
  rounding: { below10k: 10, above10k: 100 },
  "discounting.enabled": true,
};

// Pure — takes a flat {key: value} object (already merged with DEFAULTS
// by the caller) and returns computeEnvelope's nested shape. No I/O, no
// cache. Used by both loadPricingConfig (below, with the real DB rows)
// and pricingConfigController's preview endpoint (with a flat object that
// has the staff member's proposed, not-yet-saved changes merged in).
function assembleConfig(flat) {
  return {
    member: {
      basePct: flat["member.basePct"],
      floorMode: flat["member.floorMode"],
    },
    margin: {
      bandThreshold: flat["margin.bandThreshold"],
      minBelow: flat["margin.minBelow"],
      minAbove: flat["margin.minAbove"],
      smoothing: {
        enabled: flat["margin.smoothing.enabled"],
        minProfit: flat["margin.smoothing.minProfit"],
      },
    },
    ceiling: { maxTotalPct: flat["ceiling.maxTotalPct"] },
    lever: {
      richMargin: flat["lever.richMargin"],
      oldModel: { pct: flat["lever.oldModel.pct"] },
      offSeason: flat["lever.offSeason"],
      tier: flat["lever.tier"],
      ltv: flat["lever.ltv"],
      bundle: flat["lever.bundle"],
    },
    ladder: { steps: flat["ladder.steps"], thinRoom: flat["ladder.thinRoom"] },
    agent: { maxOrderForLevers: flat["agent.maxOrderForLevers"] },
    offer: { validityHours: flat["offer.validityHours"] },
    rounding: flat.rounding,
    discounting: { enabled: flat["discounting.enabled"] },
  };
}

// Module-level, short TTL — pricing config changes rarely (an owner
// editing a setting in Settings), and get_price_envelope can be called
// several times per conversation turn (once per cart line). Re-querying
// all 20-ish rows on every single line item would be wasteful. 60s means
// a config edit takes effect within a minute, matching the acceptance
// criterion in the build spec ("updates envelopes within one minute, with
// no deploy").
let cache = null;
let cacheExpiresAt = 0;
const CACHE_TTL_MS = 60 * 1000;

async function loadPricingConfig({ skipCache = false } = {}) {
  if (!skipCache && cache && Date.now() < cacheExpiresAt) {
    return cache;
  }

  const rows = await prisma.pricingConfig.findMany();
  const flat = { ...DEFAULTS };
  for (const row of rows) {
    flat[row.key] = row.value;
  }

  const config = assembleConfig(flat);

  cache = config;
  cacheExpiresAt = Date.now() + CACHE_TTL_MS;
  return config;
}

// Exposed for anything that needs to force a fresh read right after an
// owner edits a PricingConfig row from the console (Phase 5) — avoids
// waiting out the 60s cache for a change that should feel immediate in
// the settings-preview UI.
function invalidatePricingConfigCache() {
  cache = null;
}

module.exports = {
  loadPricingConfig,
  invalidatePricingConfigCache,
  assembleConfig,
  DEFAULTS,
};
