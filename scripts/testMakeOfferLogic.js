// scripts/testMakeOfferLogic.js
//
// Your dev DB currently has no product with real negotiable room under
// the seeded PricingConfig (every sampled item's floor lands at or above
// the member price), so testPricingEngine.js can prove get_price_envelope
// is safe and make_offer enforces the floor and accepts a valid offer —
// but can't exercise the step-skip rejection, since every test price
// collapses to the same number.
//
// This script tests JUST that remaining piece, in isolation: it mocks
// Prisma and the two pricing-engine helpers with a synthetic
// high-margin item (guaranteed real room), and calls your REAL
// make_offer function from the REAL salesAgentTools.js — only the data
// underneath it is fake, not the logic being tested.
//
// Run from the backend repo root:
//   node scripts/testMakeOfferLogic.js
//
// No real DB writes happen — Prisma is fully mocked.

const assert = require("assert");
const Module = require("module");

function pass(label) {
  console.log(`PASS - ${label}`);
}
function fail(label, detail) {
  console.log(`FAIL - ${label}`);
  if (detail !== undefined) console.log("  ->", detail);
  process.exitCode = 1;
}

// In-memory fake Offer table — just enough to exercise make_offer's real
// queries (findFirst by customer+variant, update to supersede, create).
let offers = [];
let nextOfferId = 1;

const fakePrisma = {
  customer: {
    findUnique: async () => ({
      id: "cust-1",
      isMember: true,
      tier: "STANDARD",
      ltvPercentile: null,
    }),
  },
  discountCampaign: {
    findMany: async () => [],
  },
  offer: {
    findFirst: async ({ where, orderBy }) => {
      let matches = offers.filter(
        (o) =>
          o.customerId === where.customerId && o.variantId === where.variantId,
      );
      if (where.status)
        matches = matches.filter((o) => o.status === where.status);
      if (where.expiresAt?.gt) {
        matches = matches.filter((o) => o.expiresAt > where.expiresAt.gt);
      }
      if (!matches.length) return null;
      // orderBy createdAt desc — our array is already append-only in order
      return matches[matches.length - 1];
    },
    update: async ({ where, data }) => {
      const offer = offers.find((o) => o.id === where.id);
      Object.assign(offer, data);
      return offer;
    },
    create: async ({ data }) => {
      const offer = { id: `offer-${nextOfferId++}`, ...data };
      offers.push(offer);
      return offer;
    },
  },
};

// Synthetic high-margin item: list 50,000, cost 20,000 — plenty of room
// between member price and floor, guaranteed to produce real
// suggestedSteps regardless of what's actually in the dev DB.
const fakeResolved = {
  "variant-1": {
    variant: {
      id: "variant-1",
      listPrice: 50000,
      costPrice: 20000,
      availabilityStatus: "IN_STOCK",
    },
    product: { id: "product-1", pricingLocked: false, isSeasonal: false },
  },
};

const fakeConfig = {
  member: { basePct: 10, floorMode: "margin_wins" },
  margin: {
    bandThreshold: 100000,
    minBelow: 0.2,
    minAbove: 0.15,
    smoothing: { enabled: false, minProfit: 0 },
  },
  ceiling: { maxTotalPct: 25 },
  lever: {
    // minListMargin: 0.5 — this item's margin is 1 - 20000/50000 = 0.6,
    // so richMargin fires and adds 5% beyond the base 10% member
    // discount. Without at least one lever firing, lowestAgentPrice
    // always equals memberPrice exactly BY DESIGN (room only comes from
    // levers stacking on top of the base discount, never from cost
    // headroom alone) — that's what made the first version of this
    // script fail: every lever was set to pct:0 on purpose, so there
    // was never any room to test against, same as your real dev DB's
    // products that had no lever conditions met.
    richMargin: { minListMargin: 0.5, pct: 5 },
    oldModel: { pct: 0 },
    offSeason: { months: [1, 12], pct: 0 },
    tier: { STANDARD: 0, SILVER: 2, GOLD: 3, PLATINUM: 5 },
    ltv: { topPercentile: 10, pct: 0 },
    bundle: { minItems: 99, minOrderValue: 9999999, pct: 0 },
  },
  ladder: { steps: [0.4, 0.75, 1.0], thinRoom: { minRupees: 500, minPct: 1 } },
  agent: { maxOrderForLevers: 9999999 },
  rounding: { below10k: 10, above10k: 100 },
  discounting: { enabled: true },
  offer: { validityHours: 48 },
};

// Intercept require() calls for the three modules make_offer depends on,
// so salesAgentTools.js gets our fakes instead of real Prisma/DB queries,
// with zero changes to the real file.
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "../../lib/prisma") return { prisma: fakePrisma };
  if (id.endsWith("pricingConfigLoader")) {
    return {
      loadPricingConfig: async () => fakeConfig,
      invalidatePricingConfigCache: () => {},
    };
  }
  if (id.endsWith("resolveVariantPricingInputs")) {
    return { resolveVariantPricingInputs: async () => fakeResolved };
  }
  return originalRequire.apply(this, arguments);
};

const {
  buildSalesAgentTools,
} = require("../src/services/salesAgent/salesAgentTools");
Module.prototype.require = originalRequire; // restore immediately after loading

async function main() {
  console.log(
    "=== make_offer step-ladder logic test (mocked DB, synthetic high-margin item) ===\n",
  );

  const context = {
    customer: { id: "cust-1", isMember: true, tier: "STANDARD" },
    conversation: { id: "conv-1" },
    unansweredQuestions: [],
  };
  const tools = buildSalesAgentTools(context);

  const envelope = await tools.get_price_envelope({
    lines: [{ variantId: "variant-1", qty: 1 }],
  });
  const line = envelope[0];
  console.log("Synthetic envelope:", JSON.stringify(line, null, 2));

  if (line.lowestAgentPrice >= line.memberPrice) {
    fail(
      "synthetic item has real negotiable room (test setup is broken, not your code)",
      line,
    );
    return;
  }
  pass(
    `synthetic item has real room (memberPrice=${line.memberPrice}, lowestAgentPrice=${line.lowestAgentPrice})`,
  );

  // step 0 — member price, must succeed
  const step0 = await tools.make_offer({
    variantId: "variant-1",
    price: line.memberPrice,
    step: 0,
  });
  if (step0.offerId && step0.step === 0) {
    pass(`step 0 accepted (price=${step0.price})`);
  } else {
    fail("step 0 accepted", step0);
  }

  // skip straight to step 2 — must be rejected
  const skip = await tools.make_offer({
    variantId: "variant-1",
    price: line.lowestAgentPrice,
    step: 2,
  });
  if (skip.error === "step_skips_ahead" && skip.nextAllowedStep === 1) {
    pass(
      `step-2 skip correctly rejected (nextAllowedStep=${skip.nextAllowedStep})`,
    );
  } else {
    fail("step-2 skip correctly rejected", skip);
  }

  // step 1 with a real concession price (strictly between member price and floor) — must succeed
  const midPoint = Math.round((line.memberPrice + line.lowestAgentPrice) / 2);
  const step1 = await tools.make_offer({
    variantId: "variant-1",
    price: midPoint,
    step: 1,
  });
  if (step1.offerId && step1.step === 1 && step1.price === midPoint) {
    pass(`step 1 accepted after step 0 (price=${midPoint})`);
  } else {
    fail("step 1 accepted after step 0", step1);
  }

  // now step 2 for real (after step 1 happened) — must succeed
  const step2 = await tools.make_offer({
    variantId: "variant-1",
    price: line.lowestAgentPrice,
    step: 2,
  });
  if (
    step2.offerId &&
    step2.step === 2 &&
    step2.price === line.lowestAgentPrice
  ) {
    pass(`step 2 accepted after step 1 (price=${line.lowestAgentPrice})`);
  } else {
    fail("step 2 accepted after step 1", step2);
  }

  // below floor — must still be rejected even mid-ladder
  const belowFloor = await tools.make_offer({
    variantId: "variant-1",
    price: line.lowestAgentPrice - 1,
    step: 3,
  });
  if (belowFloor.error === "price_below_lowest_allowed") {
    pass("price below floor rejected even at a legitimate next step");
  } else {
    fail(
      "price below floor rejected even at a legitimate next step",
      belowFloor,
    );
  }

  // re-requesting the exact same active price — must return the SAME offerId, not create a new one
  const repeat = await tools.make_offer({
    variantId: "variant-1",
    price: line.lowestAgentPrice,
    step: 2,
  });
  if (repeat.offerId === step2.offerId) {
    pass(
      "re-requesting the same active price returns the existing offer idempotently",
    );
  } else {
    fail(
      "re-requesting the same active price returns the existing offer idempotently",
      repeat,
    );
  }
}

main();
