// scripts/testCheckoutDiscounts.js
//
// DEV DATABASE + DEV SHOPIFY STORE. Exercises create_checkout_link (and
// sanity-checks the number enroll_membership now passes to Shopify) end
// to end against real data. Creates real Offer rows and real Shopify
// discount codes — see the cleanup note printed at the end.
//
// Does NOT re-run the full enroll_membership chat flow (that onboarding
// path was already verified earlier in the project) — it only checks the
// one thing Phase 4 actually added there: that config.member.basePct is
// a real, sane number before it's ever handed to Shopify as a discount
// percentage. enroll_membership's own Shopify call is the exact same
// function already proven working in testShopifyDiscounts.js.
//
// Run from the backend repo root:
//   node scripts/testCheckoutDiscounts.js

const { prisma } = require("../src/lib/prisma");
const {
  buildSalesAgentTools,
} = require("../src/services/salesAgent/salesAgentTools");
const {
  loadPricingConfig,
} = require("../src/services/pricingEngine/pricingConfigLoader");

function pass(label) {
  console.log(`PASS - ${label}`);
}
function fail(label, detail) {
  console.log(`FAIL - ${label}`);
  if (detail !== undefined) console.log("  ->", detail);
  process.exitCode = 1;
}

async function findConversationFor(customerId) {
  let conversation = await prisma.conversation.findFirst({
    where: { customerId },
    orderBy: { createdAt: "desc" },
  });
  if (!conversation) {
    conversation = await prisma.conversation.findFirst({
      orderBy: { createdAt: "desc" },
    });
  }
  return conversation;
}

// Finds a variant that actually has real negotiable room under the
// current config, skipping any the caller has already used this run (so
// scenario B and scenario C don't collide on the same item).
async function findVariantWithRoom(tools, usedIds) {
  const candidates = await prisma.variant.findMany({
    where: {
      SupplierProduct: { some: { isPrimary: true, costPrice: { not: null } } },
      id: { notIn: [...usedIds] },
    },
    include: { Product: true },
    take: 25,
  });
  for (const candidate of candidates) {
    const result = await tools.get_price_envelope({
      lines: [{ variantId: candidate.id, qty: 1 }],
    });
    const line = Array.isArray(result) ? result[0] : null;
    if (line && !line.error && line.lowestAgentPrice < line.memberPrice) {
      return { variant: candidate, line };
    }
  }
  return null;
}

async function main() {
  console.log(
    "=== create_checkout_link integration test (DEV DB + DEV SHOPIFY) ===\n",
  );

  // --- 0. Sanity check the number enroll_membership now sends to Shopify -
  const config = await loadPricingConfig();
  const basePct = config.member.basePct;
  if (typeof basePct === "number" && basePct > 0 && basePct < 100) {
    pass(
      `config.member.basePct is sane (${basePct}) — safe to hand to Shopify as a discount %`,
    );
  } else {
    fail("config.member.basePct is sane", basePct);
  }

  const member = await prisma.customer.findFirst({ where: { isMember: true } });
  if (!member) {
    console.log("No member customer found — skipping member-path tests.");
  }

  // --- A. Non-member: plain list-price link, no discount code -----------
  const nonMember = await prisma.customer.findFirst({
    where: { isMember: false },
  });
  if (nonMember) {
    const variant = await prisma.variant.findFirst();
    if (variant) {
      const conversation = await findConversationFor(nonMember.id);
      const tools = buildSalesAgentTools({
        customer: nonMember,
        conversation: { id: conversation?.id || null, sessionExpiresAt: null },
        unansweredQuestions: [],
      });
      const result = await tools.create_checkout_link({
        variantIds: [variant.id],
        quantities: [1],
      });
      if (
        !result.checkoutUrl.includes("/discount/") &&
        result.totalInr === Number(variant.price)
      ) {
        pass(
          `non-member checkout: plain list-price link, no discount code (totalInr=${result.totalInr})`,
        );
      } else {
        fail(
          "non-member checkout: plain list-price link, no discount code",
          result,
        );
      }
    } else {
      console.log("No variant at all in DB — skipping non-member test.");
    }
  } else {
    console.log("No non-member customer found — skipping non-member test.");
  }

  if (!member) {
    await prisma.$disconnect();
    return;
  }

  const conversation = await findConversationFor(member.id);
  if (!conversation) {
    console.log(
      "No Conversation rows exist — skipping member-path tests (make_offer/create_checkout_link both need one).",
    );
    await prisma.$disconnect();
    return;
  }

  const context = {
    customer: member,
    conversation: { id: conversation.id, sessionExpiresAt: null },
    unansweredQuestions: [],
  };
  const tools = buildSalesAgentTools(context);

  // --- B. Member, no active offer: flat member price, real discount code
  const found1 = await findVariantWithRoom(tools, new Set());
  if (!found1) {
    console.log(
      "No variant with real negotiable room found — skipping member-path discount tests (same gap as the earlier pricing-engine test run).",
    );
    await prisma.$disconnect();
    return;
  }
  const { variant: variantB, line: lineB } = found1;

  // Reset any leftover active Offer on this exact customer+variant from a
  // previous test run, so this scenario deterministically has NO active
  // offer — otherwise a stale Offer from an earlier run would silently
  // turn this into scenario C instead.
  await prisma.offer.updateMany({
    where: { customerId: member.id, variantId: variantB.id, status: "active" },
    data: { status: "superseded" },
  });

  const resultB = await tools.create_checkout_link({
    variantIds: [variantB.id],
    quantities: [1],
  });
  console.log(
    "\nScenario B (member, no active offer) result:",
    JSON.stringify(resultB, null, 2),
  );
  if (
    resultB.checkoutUrl.includes("/discount/") &&
    resultB.totalInr === lineB.memberPrice &&
    resultB.savingsInr === Number(variantB.price) - lineB.memberPrice
  ) {
    pass(
      `member checkout (no offer): correct member price, real discount code minted (totalInr=${resultB.totalInr}, savings=${resultB.savingsInr})`,
    );
  } else {
    fail(
      "member checkout (no offer): correct member price, real discount code minted",
      resultB,
    );
  }

  // --- C. Member with an active negotiated Offer: offer price wins -----
  const found2 = await findVariantWithRoom(tools, new Set([variantB.id]));
  if (!found2) {
    console.log(
      "No second variant with real room found — skipping the active-offer scenario.",
    );
    await prisma.$disconnect();
    return;
  }
  const { variant: variantC, line: lineC } = found2;
  await prisma.offer.updateMany({
    where: { customerId: member.id, variantId: variantC.id, status: "active" },
    data: { status: "superseded" },
  });

  const concessionPrice = Math.round(
    (lineC.memberPrice + lineC.lowestAgentPrice) / 2,
  );
  const offer = await tools.make_offer({
    variantId: variantC.id,
    price: concessionPrice,
    step: 1,
  });
  if (!offer.offerId) {
    fail("setting up a real negotiated offer for scenario C", offer);
    await prisma.$disconnect();
    return;
  }

  // Cart of BOTH items — proves the "calculate variant-wise, apply
  // cart-wise" total is correct: variantB at plain member price (fresh
  // envelope, since its superseded offer no longer counts) + variantC at
  // its negotiated offer price, in ONE checkout with ONE discount code.
  const resultC = await tools.create_checkout_link({
    variantIds: [variantB.id, variantC.id],
    quantities: [1, 1],
  });
  console.log(
    "\nScenario C (member, cart with one negotiated offer) result:",
    JSON.stringify(resultC, null, 2),
  );
  const expectedTotal = lineB.memberPrice + concessionPrice;
  const expectedSavings =
    Number(variantB.price) -
    lineB.memberPrice +
    (Number(variantC.price) - concessionPrice);
  if (
    resultC.checkoutUrl.includes("/discount/") &&
    resultC.totalInr === expectedTotal &&
    resultC.savingsInr === expectedSavings
  ) {
    pass(
      `two-item cart: negotiated price honoured, correct combined total (totalInr=${resultC.totalInr}, savings=${resultC.savingsInr})`,
    );
  } else {
    fail("two-item cart: negotiated price honoured, correct combined total", {
      got: resultC,
      expectedTotal,
      expectedSavings,
    });
  }

  console.log(
    "\nThis run created real Offer rows and real single-use Shopify discount " +
      'codes (visible in Shopify Admin -> Discounts, titled "Checkout — CO..."). ' +
      "They expire on their own in 48h and are single-use, so they're harmless " +
      "to leave — delete them from Shopify Admin if you want a clean slate.",
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Script crashed:", err?.response?.data || err);
  await prisma.$disconnect();
  process.exit(1);
});
