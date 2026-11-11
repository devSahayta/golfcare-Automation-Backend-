// scripts/testPricingEngine.js
//
// DEV DATABASE ONLY. This writes real Offer rows against a real
// customer+variant it finds in your DB. Do NOT point this at production.
//
// Run from the backend repo root:
//   node scripts/testPricingEngine.js
//
// What it does, in order:
//   1. Finds a real member customer and a real variant that has cost
//      data (so resolveVariantPricingInputs has something to resolve).
//   2. Calls get_price_envelope and checks the agent-facing result has
//      NO internal fields (_full, costPrice, floorPrice, leversApplied)
//      anywhere in it.
//   3. Calls make_offer below the floor -> must be rejected.
//   4. Calls make_offer at member price (step 0) -> must succeed.
//   5. Calls make_offer skipping ahead to step 2 without step 1 having
//      happened -> must be rejected.
//   6. Calls make_offer at step 1 with a valid price -> must succeed.
//
// If every check prints PASS, Phase 3 is wired correctly end-to-end
// against your real schema and real data.

const assert = require("assert");
const { prisma } = require("../src/lib/prisma");
const {
  buildSalesAgentTools,
} = require("../src/services/salesAgent/salesAgentTools");

function pass(label) {
  console.log(`PASS - ${label}`);
}
function fail(label, detail) {
  console.log(`FAIL - ${label}`);
  if (detail !== undefined) console.log("  ->", detail);
  process.exitCode = 1;
}

async function main() {
  console.log("=== Pricing engine integration test (DEV DB ONLY) ===\n");

  // --- 1. Find real test data -------------------------------------------
  const customer = await prisma.customer.findFirst({
    where: { isMember: true },
  });
  if (!customer) {
    console.log(
      "No member customer found in this DB. Make any one customer a member " +
        "(isMember: true) and re-run.",
    );
    process.exit(1);
  }

  // Pull a batch of candidates (not just one) — a single pricingLocked or
  // zero-margin item has NO negotiable room at all (memberPrice ==
  // lowestAgentPrice), which makes step-1/step-2 offers collapse to the
  // same price as step-0 and silently short-circuits the ladder checks
  // below without actually testing them. Scan several real candidates and
  // use the first one that genuinely has room once we compute its envelope.
  const candidates = await prisma.variant.findMany({
    where: {
      SupplierProduct: { some: { isPrimary: true, costPrice: { not: null } } },
    },
    include: { Product: true },
    take: 25,
  });
  if (!candidates.length) {
    console.log(
      "No variant with a primary SupplierProduct.costPrice set was found. " +
        "Pick any product your supplier agent has already priced and re-run.",
    );
    process.exit(1);
  }

  console.log(`Using customer: ${customer.id} (tier=${customer.tier})\n`);

  // make_offer writes an Offer row with a real foreign key to
  // Conversation — a made-up conversation id fails that constraint. Use
  // this customer's own most recent real conversation if one exists,
  // otherwise fall back to any conversation in the DB (Offer only needs
  // a valid conversationId to satisfy the FK; it doesn't have to belong
  // to this exact customer for this test).
  let conversation = await prisma.conversation.findFirst({
    where: { customerId: customer.id },
    orderBy: { createdAt: "desc" },
  });
  if (!conversation) {
    conversation = await prisma.conversation.findFirst({
      orderBy: { createdAt: "desc" },
    });
  }
  if (!conversation) {
    console.log(
      "No Conversation rows exist in this DB at all, so make_offer can't " +
        "satisfy its foreign key. Have any one real WhatsApp conversation " +
        "happen in dev first, then re-run.",
    );
    process.exit(1);
  }
  console.log(`Using conversation: ${conversation.id}\n`);

  const context = {
    customer,
    conversation: { id: conversation.id, sessionExpiresAt: null },
    unansweredQuestions: [],
  };
  const tools = buildSalesAgentTools(context);

  // --- 2. get_price_envelope + no-leak check ----------------------------
  // Scan candidates for the first one with REAL negotiable room
  // (lowestAgentPrice strictly below memberPrice). An item with zero room
  // still passes the no-leak check, but can't meaningfully test the
  // below-floor / step-ladder logic below (every price collapses to the
  // same number), which is exactly what happened on the previous run.
  let variant = null;
  let line = null;
  let lastResult = null;
  for (const candidate of candidates) {
    const result = await tools.get_price_envelope({
      lines: [{ variantId: candidate.id, qty: 1 }],
    });
    const candidateLine = Array.isArray(result) ? result[0] : null;
    if (!candidateLine || candidateLine.error) continue;
    lastResult = { variant: candidate, line: candidateLine };
    if (candidateLine.lowestAgentPrice < candidateLine.memberPrice) {
      variant = candidate;
      line = candidateLine;
      break;
    }
  }
  if (!variant && lastResult) {
    // Nothing had real room — fall back to the last candidate so the
    // no-leak check still runs, but flag it so the step-ladder results
    // below are read correctly (SKIP, not a real pass/fail).
    variant = lastResult.variant;
    line = lastResult.line;
  }
  if (!variant) {
    fail("get_price_envelope returned a usable envelope for any candidate");
    await prisma.$disconnect();
    return;
  }

  const hasRealRoom = line.lowestAgentPrice < line.memberPrice;
  console.log(`Using variant: ${variant.id} (${variant.title})`);
  console.log(`Has negotiable room: ${hasRealRoom}\n`);
  console.log("get_price_envelope result:", JSON.stringify(line, null, 2));
  pass("get_price_envelope returned an envelope");

  const serialized = JSON.stringify(line);
  const leakKeys = [
    "_full",
    "costPrice",
    "floorPrice",
    "leversApplied",
    "belowFloorAtList",
  ];
  const leaked = leakKeys.filter((k) => serialized.includes(k));
  if (leaked.length) {
    fail("no internal fields leaked to agent", `found: ${leaked.join(", ")}`);
  } else {
    pass(
      "no internal fields (_full/costPrice/floorPrice/leversApplied) leaked to agent",
    );
  }

  if (!hasRealRoom) {
    console.log(
      "\nNone of the scanned candidates had real negotiable room (all hit " +
        "the no-discount short-circuit: pricingLocked, no cost, or " +
        "discounting disabled). The below-floor check below is still a " +
        "valid test; the step-1/step-2 ladder checks after it will be " +
        "degenerate (every price collapses to the same number) — not a " +
        "real pass or fail. To test those properly, make sure at least one " +
        "product in your dev DB has discounting enabled, is not " +
        "pricingLocked, and has a real cost price below list price.",
    );
  }

  // --- 3. make_offer below floor must be rejected ------------------------
  const belowFloor = Math.max(0, line.lowestAgentPrice - 1);
  const rejectedOffer = await tools.make_offer({
    variantId: variant.id,
    price: belowFloor,
    step: 1,
  });
  if (rejectedOffer.error === "price_below_lowest_allowed") {
    pass(`make_offer rejected a below-floor price (${belowFloor})`);
  } else {
    fail("make_offer rejected a below-floor price", rejectedOffer);
  }

  // --- 4. make_offer at member price (step 0) must succeed ---------------
  const step0 = await tools.make_offer({
    variantId: variant.id,
    price: line.memberPrice,
    step: 0,
  });
  if (step0.offerId && step0.price === line.memberPrice) {
    pass(
      `make_offer accepted member price at step 0 (offerId=${step0.offerId})`,
    );
  } else {
    fail("make_offer accepted member price at step 0", step0);
  }

  // --- 5. make_offer skipping ahead to step 2 must be rejected ------------
  const skipAhead = await tools.make_offer({
    variantId: variant.id,
    price: line.lowestAgentPrice,
    step: 2,
  });
  if (skipAhead.error === "step_skips_ahead") {
    pass("make_offer rejected skipping from step 0 straight to step 2");
  } else {
    fail(
      "make_offer rejected skipping from step 0 straight to step 2",
      skipAhead,
    );
  }

  // --- 6. make_offer at step 1 with a valid price must succeed -----------
  const midPoint = Math.round((line.memberPrice + line.lowestAgentPrice) / 2);
  const step1 = await tools.make_offer({
    variantId: variant.id,
    price: midPoint,
    step: 1,
  });
  if (step1.offerId && step1.step === 1) {
    pass(
      `make_offer accepted a valid step-1 concession (price=${midPoint}, offerId=${step1.offerId})`,
    );
  } else {
    fail("make_offer accepted a valid step-1 concession", step1);
  }

  console.log(
    "\nNote: this created real Offer rows for this customer+variant in " +
      "your dev DB (status=superseded/active). Safe to leave, or delete " +
      "them manually from the Offer table if you want a clean slate.",
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("Script crashed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
