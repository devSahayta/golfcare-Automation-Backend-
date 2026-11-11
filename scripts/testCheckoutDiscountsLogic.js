// scripts/testCheckoutDiscountsLogic.js
//
// Your dev DB currently has no product with real negotiable room (same
// gap testCheckoutDiscounts.js hit), so scenarios B and C there got
// skipped. This tests JUST that remaining logic in create_checkout_link
// — correct member pricing, correct active-offer pricing, correct
// cart-total discount — using synthetic high-margin data, same approach
// as testMakeOfferLogic.js. Prisma AND Shopify are both mocked — no real
// DB writes, no real Shopify API calls, nothing to clean up afterward.
//
// Run from the backend repo root:
//   node scripts/testCheckoutDiscountsLogic.js

const Module = require("module");

function pass(label) {
  console.log(`PASS - ${label}`);
}
function fail(label, detail) {
  console.log(`FAIL - ${label}`);
  if (detail !== undefined) console.log("  ->", detail);
  process.exitCode = 1;
}

let offers = [];
let nextOfferId = 1;
let mintedCodes = [];

const fakePrisma = {
  customer: {
    findUnique: async () => ({
      id: "cust-1",
      isMember: true,
      tier: "STANDARD",
      ltvPercentile: null,
    }),
  },
  discountCampaign: { findMany: async () => [] },
  auditLog: { create: async () => ({}) },
  offer: {
    findFirst: async ({ where }) => {
      let matches = offers.filter(
        (o) =>
          o.customerId === where.customerId && o.variantId === where.variantId,
      );
      if (where.status)
        matches = matches.filter((o) => o.status === where.status);
      if (where.expiresAt?.gt)
        matches = matches.filter((o) => o.expiresAt > where.expiresAt.gt);
      return matches.length ? matches[matches.length - 1] : null;
    },
    updateMany: async ({ where, data }) => {
      offers
        .filter(
          (o) =>
            o.customerId === where.customerId &&
            o.variantId === where.variantId &&
            o.status === where.status,
        )
        .forEach((o) => Object.assign(o, data));
      return {};
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

// Two synthetic high-margin items, each with its own margin so the
// two-item cart test proves each line is priced INDEPENDENTLY and then
// summed correctly — not just the same number doubled.
const fakeResolved = {
  "variant-1": {
    variant: {
      id: "variant-1",
      shopifyVariantId: "9991",
      listPrice: 50000,
      costPrice: 20000,
      availabilityStatus: "IN_STOCK",
    },
    product: { id: "product-1", pricingLocked: false, isSeasonal: false },
  },
  "variant-2": {
    variant: {
      id: "variant-2",
      shopifyVariantId: "9992",
      listPrice: 20000,
      costPrice: 12000,
      availabilityStatus: "IN_STOCK",
    },
    product: { id: "product-2", pricingLocked: false, isSeasonal: false },
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
    richMargin: { minListMargin: 0.5, pct: 5 }, // fires for both synthetic items (0.6 and 0.4 margin respectively — see note below)
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
// variant-2 margin = 1 - 12000/20000 = 0.4, still >= minListMargin 0.5? No —
// 0.4 < 0.5, so richMargin WON'T fire for variant-2. That's intentional:
// it proves the two-item cart test still sums correctly even when the two
// lines have different lever outcomes, not just two copies of the same
// envelope.

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
    return {
      resolveVariantPricingInputs: async (ids) =>
        Object.fromEntries(ids.map((id) => [id, fakeResolved[id]])),
    };
  }
  if (id.endsWith("shopifyDiscounts")) {
    return {
      createStandingMemberDiscountCode: async () => ({}),
      createCartDiscountCode: async ({ code, amountOff, expiresAt }) => {
        mintedCodes.push({ code, amountOff, expiresAt });
        return { priceRuleId: "fake", code };
      },
    };
  }
  return originalRequire.apply(this, arguments);
};
const {
  buildSalesAgentTools,
} = require("../src/services/salesAgent/salesAgentTools");
Module.prototype.require = originalRequire;

async function main() {
  console.log(
    "=== create_checkout_link logic test (mocked DB + mocked Shopify) ===\n",
  );

  const context = {
    customer: { id: "cust-1", isMember: true, tier: "STANDARD" },
    conversation: { id: "conv-1" },
    unansweredQuestions: [],
  };
  const tools = buildSalesAgentTools(context);

  // --- B. No active offer: plain member price, real discount minted ----
  const resultB = await tools.create_checkout_link({
    variantIds: ["variant-1"],
    quantities: [1],
  });
  console.log("Scenario B result:", JSON.stringify(resultB, null, 2));
  // variant-1: list 50000, richMargin fires (+5%), target 15%, allowed = max(42500, floor 25000) = 42500,
  // memberPrice = 45000 (base 10% only, levers don't lower memberPrice itself) -> create_checkout_link
  // uses memberPrice (45000), NOT lowestAgentPrice (42500), when there's no active offer.
  if (
    resultB.totalInr === 45000 &&
    resultB.savingsInr === 5000 &&
    resultB.checkoutUrl.includes("/discount/")
  ) {
    pass(
      `no-offer checkout uses plain member price (45000), not the deeper lowestAgentPrice — savings=${resultB.savingsInr}`,
    );
  } else {
    fail("no-offer checkout uses plain member price", resultB);
  }
  if (mintedCodes.length === 1 && mintedCodes[0].amountOff === 5000) {
    pass("exactly one discount code minted, for the correct amount");
  } else {
    fail(
      "exactly one discount code minted, for the correct amount",
      mintedCodes,
    );
  }

  // --- C. Active negotiated offer wins over plain member price ---------
  await tools.make_offer({ variantId: "variant-1", price: 45000, step: 0 });
  const offerResult = await tools.make_offer({
    variantId: "variant-1",
    price: 43750,
    step: 1,
  });
  mintedCodes = [];
  const resultC = await tools.create_checkout_link({
    variantIds: ["variant-1"],
    quantities: [1],
  });
  console.log("\nScenario C result:", JSON.stringify(resultC, null, 2));
  if (resultC.totalInr === 43750 && resultC.savingsInr === 50000 - 43750) {
    pass(
      `active negotiated offer price (43750) wins over plain member price (45000)`,
    );
  } else {
    fail("active negotiated offer price wins over plain member price", resultC);
  }

  // --- D. Two-item cart: one offer, one plain member price, ONE code ---
  mintedCodes = [];
  const resultD = await tools.create_checkout_link({
    variantIds: ["variant-1", "variant-2"],
    quantities: [1, 1],
  });
  console.log("\nScenario D result:", JSON.stringify(resultD, null, 2));
  // variant-1 (has the active offer from scenario C): 43750
  // variant-2: richMargin does NOT fire (margin 0.4 < 0.5 threshold) -> memberPrice = 20000*0.9 = 18000
  const expectedTotal = 43750 + 18000;
  const expectedSavings = 50000 - 43750 + (20000 - 18000);
  if (
    resultD.totalInr === expectedTotal &&
    resultD.savingsInr === expectedSavings &&
    mintedCodes.length === 1
  ) {
    pass(
      `two-item cart sums correctly (offer price + plain member price) into ONE discount code (total=${resultD.totalInr}, savings=${resultD.savingsInr})`,
    );
  } else {
    fail("two-item cart sums correctly into one discount code", {
      got: resultD,
      expectedTotal,
      expectedSavings,
      codesMinted: mintedCodes.length,
    });
  }

  // --- E. Non-member: no discount code at all ----------------------------
  const nonMemberTools = buildSalesAgentTools({
    customer: { id: "cust-2", isMember: false },
    conversation: { id: "conv-1" },
    unansweredQuestions: [],
  });
  mintedCodes = [];
  // Override fakePrisma.customer.findUnique just for this call via closure trick:
  const originalFindUnique = fakePrisma.customer.findUnique;
  fakePrisma.customer.findUnique = async () => ({
    id: "cust-2",
    isMember: false,
    tier: "STANDARD",
  });
  const resultE = await nonMemberTools.create_checkout_link({
    variantIds: ["variant-1"],
    quantities: [1],
  });
  fakePrisma.customer.findUnique = originalFindUnique;
  console.log("\nScenario E result:", JSON.stringify(resultE, null, 2));
  if (
    resultE.totalInr === 50000 &&
    !resultE.checkoutUrl.includes("/discount/") &&
    mintedCodes.length === 0
  ) {
    pass("non-member gets plain list-price link, zero discount codes minted");
  } else {
    fail(
      "non-member gets plain list-price link, zero discount codes minted",
      resultE,
    );
  }
}

main();
