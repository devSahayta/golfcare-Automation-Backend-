const assert = require("assert");
const {
  computeEnvelope,
} = require("./src/services/pricingEngine/computeEnvelope");

const defaultConfig = {
  member: { basePct: 10, floorMode: "margin_wins" },
  margin: {
    bandThreshold: 100000,
    minBelow: 0.25,
    minAbove: 0.15,
    smoothing: { enabled: false, minProfit: 25000 },
  },
  ceiling: { maxTotalPct: 25 },
  lever: {
    richMargin: { minListMargin: 0.45, pct: 2 },
    oldModel: { pct: 5 },
    offSeason: { months: [4, 9], pct: 2 },
    tier: { STANDARD: 0, SILVER: 2, GOLD: 3, PLATINUM: 5 },
    ltv: { topPercentile: 10, pct: 2 },
    bundle: { minItems: 2, minOrderValue: 10000, pct: 2 },
  },
  ladder: { steps: [0.4, 0.75, 1.0], thinRoom: { minRupees: 200, minPct: 2 } },
  agent: { maxOrderForLevers: 40000 },
  rounding: { below10k: 10, above10k: 100 },
  discounting: { enabled: true },
};

const NOW = new Date("2026-01-15T00:00:00Z"); // January: outside offSeason window, avoids accidental trigger

function run(name, input, expect) {
  const env = computeEnvelope({ now: NOW, config: defaultConfig, ...input });
  console.log(`\n--- ${name} ---`);
  console.log(JSON.stringify(env, null, 0));
  for (const [key, val] of Object.entries(expect)) {
    const actual = key.startsWith("_full.")
      ? env._full[key.slice(6)]
      : env[key];
    assert.deepStrictEqual(
      actual,
      val,
      `${name}: ${key} expected ${JSON.stringify(val)} got ${JSON.stringify(actual)}`,
    );
  }
  console.log(`PASS: ${name}`);
}

const baseVariant1 = {
  id: "v1",
  listPrice: 5500,
  costPrice: 3600,
  availabilityStatus: "IN_STOCK",
};
run(
  "1. Thin room (no tier/other levers)",
  {
    variant: baseVariant1,
    product: {
      id: "p1",
      isSeasonal: false,
      pricingLocked: false,
      supersededById: null,
    },
    customer: { isMember: true, tier: "STANDARD", ltvPercentile: null },
    cart: { lines: [{ variantId: "v1", qty: 1, unitListPrice: 5500 }] },
    activeCampaigns: [],
  },
  {
    "_full.floorPrice": 4800,
    memberPrice: 4950,
    lowestAgentPrice: 4950,
    thinRoom: true,
    suggestedSteps: [],
  },
);

const baseVariant2 = {
  id: "v2",
  listPrice: 30000,
  costPrice: 18000,
  availabilityStatus: "IN_STOCK",
};
run(
  "2. Normal negotiation (GOLD tier lever only)",
  {
    variant: baseVariant2,
    product: {
      id: "p2",
      isSeasonal: false,
      pricingLocked: false,
      supersededById: null,
    },
    customer: { isMember: true, tier: "GOLD", ltvPercentile: null },
    cart: { lines: [{ variantId: "v2", qty: 1, unitListPrice: 30000 }] },
    activeCampaigns: [],
  },
  {
    "_full.floorPrice": 24000,
    memberPrice: 27000,
    // target = 10% base + 3% GOLD tier = 13% -> 30000*0.87 = 26100
    lowestAgentPrice: 26100,
    "_full.leversApplied": [{ name: "tier", pct: 3 }],
  },
);

const baseVariant3 = {
  id: "v3",
  listPrice: 160000,
  costPrice: 120000,
  availabilityStatus: "IN_STOCK",
};
run(
  "3. High-ticket, floor binds (PLATINUM tier)",
  {
    variant: baseVariant3,
    product: {
      id: "p3",
      isSeasonal: false,
      pricingLocked: false,
      supersededById: null,
    },
    customer: { isMember: true, tier: "PLATINUM", ltvPercentile: null },
    cart: { lines: [{ variantId: "v3", qty: 3, unitListPrice: 160000 }] },
    activeCampaigns: [],
  },
  {
    "_full.floorPrice": 141200,
    memberPrice: 144000,
    lowestAgentPrice: 141200,
    suggestedSteps: [142900],
    canEscalateForMore: true,
  },
);

const variant4 = {
  id: "v4",
  listPrice: 2000,
  costPrice: 1450,
  availabilityStatus: "IN_STOCK",
};
run(
  "4a. 10% breaks floor, margin_wins",
  {
    variant: variant4,
    product: {
      id: "p4",
      isSeasonal: false,
      pricingLocked: false,
      supersededById: null,
    },
    customer: { isMember: true, tier: "STANDARD", ltvPercentile: null },
    cart: { lines: [{ variantId: "v4", qty: 1, unitListPrice: 2000 }] },
    activeCampaigns: [],
  },
  {
    "_full.floorPrice": 1940,
    memberPrice: 1940,
    lowestAgentPrice: 1940,
    "_full.belowFloorAtList": false,
  },
);

const config4b = {
  ...defaultConfig,
  member: { basePct: 10, floorMode: "member_wins" },
};
const env4b = computeEnvelope({
  now: NOW,
  config: config4b,
  variant: variant4,
  product: {
    id: "p4",
    isSeasonal: false,
    pricingLocked: false,
    supersededById: null,
  },
  customer: { isMember: true, tier: "STANDARD", ltvPercentile: null },
  cart: { lines: [{ variantId: "v4", qty: 1, unitListPrice: 2000 }] },
  activeCampaigns: [],
});
assert.strictEqual(env4b.memberPrice, 1800);
assert.strictEqual(env4b.lowestAgentPrice, 1800);
console.log("PASS: 4b. member_wins");

const variant5 = {
  id: "v5",
  listPrice: 101000,
  costPrice: 70000,
  availabilityStatus: "IN_STOCK",
};
const env5off = computeEnvelope({
  now: NOW,
  config: defaultConfig,
  variant: variant5,
  product: {
    id: "p5",
    isSeasonal: false,
    pricingLocked: false,
    supersededById: null,
  },
  customer: { isMember: true, tier: "STANDARD", ltvPercentile: null },
  cart: { lines: [{ variantId: "v5", qty: 1, unitListPrice: 101000 }] },
  activeCampaigns: [],
});
assert.strictEqual(env5off._full.floorPrice, 82400);
console.log("PASS: 5 smoothing off, floor =", env5off._full.floorPrice);

const config5on = {
  ...defaultConfig,
  margin: {
    ...defaultConfig.margin,
    smoothing: { enabled: true, minProfit: 25000 },
  },
};
const env5on = computeEnvelope({
  now: NOW,
  config: config5on,
  variant: variant5,
  product: {
    id: "p5",
    isSeasonal: false,
    pricingLocked: false,
    supersededById: null,
  },
  customer: { isMember: true, tier: "STANDARD", ltvPercentile: null },
  cart: { lines: [{ variantId: "v5", qty: 1, unitListPrice: 101000 }] },
  activeCampaigns: [],
});
assert.strictEqual(env5on._full.floorPrice, 95000);
console.log("PASS: 5 smoothing on, floor =", env5on._full.floorPrice);

// Replaces the old quantity-based "scarce stock" case: status-based gate.
// Anything not confirmed IN_STOCK -> all levers off, member price only.
run(
  "6. Not confirmed in stock (status gate, was qty-based scarce)",
  {
    variant: { ...baseVariant2, availabilityStatus: "ON_ORDER" },
    product: {
      id: "p2",
      isSeasonal: false,
      pricingLocked: false,
      supersededById: null,
    },
    customer: { isMember: true, tier: "GOLD", ltvPercentile: null },
    cart: { lines: [{ variantId: "v2", qty: 1, unitListPrice: 30000 }] },
    activeCampaigns: [],
  },
  {
    memberPrice: 27000,
    lowestAgentPrice: 27000,
    suggestedSteps: [],
    "_full.leversApplied": [],
  },
);

run(
  "6b. OUT_OF_STOCK also gates",
  {
    variant: { ...baseVariant2, availabilityStatus: "OUT_OF_STOCK" },
    product: {
      id: "p2",
      isSeasonal: false,
      pricingLocked: false,
      supersededById: null,
    },
    customer: { isMember: true, tier: "GOLD", ltvPercentile: null },
    cart: { lines: [{ variantId: "v2", qty: 1, unitListPrice: 30000 }] },
    activeCampaigns: [],
  },
  {
    memberPrice: 27000,
    lowestAgentPrice: 27000,
    suggestedSteps: [],
  },
);

run(
  "7. Non-member",
  {
    variant: baseVariant2,
    product: {
      id: "p2",
      isSeasonal: false,
      pricingLocked: false,
      supersededById: null,
    },
    customer: { isMember: false, tier: "GOLD", ltvPercentile: null },
    cart: { lines: [{ variantId: "v2", qty: 1, unitListPrice: 30000 }] },
    activeCampaigns: [],
  },
  {
    memberPrice: 30000,
    lowestAgentPrice: 30000,
    suggestedSteps: [],
  },
);

const variant8 = { ...baseVariant2, costPrice: null };
run(
  "8. No cost",
  {
    variant: variant8,
    product: {
      id: "p2",
      isSeasonal: false,
      pricingLocked: false,
      supersededById: null,
    },
    customer: { isMember: true, tier: "GOLD", ltvPercentile: null },
    cart: { lines: [{ variantId: "v2", qty: 1, unitListPrice: 30000 }] },
    activeCampaigns: [],
  },
  {
    memberPrice: 27000,
    suggestedSteps: [],
  },
);

const config9 = { ...defaultConfig, discounting: { enabled: false } };
const env9 = computeEnvelope({
  now: NOW,
  config: config9,
  variant: baseVariant2,
  product: {
    id: "p2",
    isSeasonal: false,
    pricingLocked: false,
    supersededById: null,
  },
  customer: { isMember: true, tier: "GOLD", ltvPercentile: null },
  cart: { lines: [{ variantId: "v2", qty: 1, unitListPrice: 30000 }] },
  activeCampaigns: [],
});
assert.strictEqual(env9.memberPrice, 27000);
assert.deepStrictEqual(env9.suggestedSteps, []);
console.log("PASS: 9 kill switch");

run(
  "10. Ceiling with campaign",
  {
    variant: baseVariant2,
    product: {
      id: "p2",
      isSeasonal: false,
      pricingLocked: false,
      supersededById: null,
    },
    customer: { isMember: true, tier: "GOLD", ltvPercentile: null },
    cart: { lines: [{ variantId: "v2", qty: 1, unitListPrice: 30000 }] },
    activeCampaigns: [{ percent: 20, scope: {} }],
  },
  {
    // target = 10 + 3(tier) + 20(campaign) = 33, capped at 25 -> 30000*0.75=22500, floor24000 wins
    "_full.floorPrice": 24000,
    lowestAgentPrice: 24000,
  },
);

console.log(
  "\nALL TEST CASES PASSED (updated for dropship: no aged/overstock, status-based gate)",
);
