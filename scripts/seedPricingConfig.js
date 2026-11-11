// scripts/seedPricingConfig.js
//
// One-time (but safe to re-run — upsert, not insert) seed of every
// tunable number from the Member Pricing Engine spec §3. Run with:
//   node scripts/seedPricingConfig.js
//
// Stored as flat key/value rows (one row per §3 line item), exactly as
// PricingConfig is shaped — NOT as one nested blob. Phase 3's config
// loader (not written yet) is responsible for assembling these flat
// rows into the nested shape computeEnvelope() expects.
//
// These are the spec's defaults, not confirmed business numbers —
// Tejas can change any of them later from the console (once built)
// without a deploy; this script only needs to run once to give the
// engine something to read.

const { prisma } = require("../src/lib/prisma");

const DEFAULTS = [
  { key: "member.basePct", value: 10 },
  { key: "member.floorMode", value: "margin_wins" },
  { key: "margin.bandThreshold", value: 100000 },
  { key: "margin.minBelow", value: 0.25 },
  { key: "margin.minAbove", value: 0.15 },
  { key: "margin.smoothing.enabled", value: false },
  { key: "margin.smoothing.minProfit", value: 25000 },
  { key: "ceiling.maxTotalPct", value: 25 },
  {
    key: "lever.aged.tiers",
    value: [
      { days: 60, pct: 3 },
      { days: 120, pct: 5 },
    ],
  },
  { key: "lever.overstock", value: { multiple: 2, windowDays: 60, pct: 2 } },
  { key: "lever.scarce.maxQty", value: 2 },
  { key: "lever.richMargin", value: { minListMargin: 0.45, pct: 2 } },
  { key: "lever.oldModel.pct", value: 5 },
  // months: [4, 9] = April through September inclusive
  { key: "lever.offSeason", value: { months: [4, 9], pct: 2 } },
  {
    key: "lever.tier",
    value: { STANDARD: 0, SILVER: 2, GOLD: 3, PLATINUM: 5 },
  },
  { key: "lever.ltv", value: { topPercentile: 10, pct: 2 } },
  { key: "lever.bundle", value: { minItems: 2, minOrderValue: 10000, pct: 2 } },
  { key: "ladder.steps", value: [0.4, 0.75, 1.0] },
  { key: "ladder.thinRoom", value: { minRupees: 200, minPct: 2 } },
  { key: "agent.maxOrderForLevers", value: 40000 },
  { key: "offer.validityHours", value: 48 },
  { key: "rounding", value: { below10k: 10, above10k: 100 } },
  { key: "discounting.enabled", value: true },
];

async function seedPricingConfig() {
  const results = [];
  for (const { key, value } of DEFAULTS) {
    const row = await prisma.pricingConfig.upsert({
      where: { key },
      // Only inserted if missing — an existing row (e.g. Tejas already
      // tuned it) is left untouched, never overwritten by a re-run.
      create: { key, value, updatedBy: "system_seed" },
      update: {},
    });
    results.push({ key: row.key, value: row.value });
  }
  return results;
}

seedPricingConfig()
  .then((rows) => {
    console.log(`PricingConfig seeded — ${rows.length} keys:`);
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error("seedPricingConfig script failed:", err.message);
    process.exit(1);
  });
