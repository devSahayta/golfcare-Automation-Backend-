// scripts/testOrderMarginCheck.js
//
// Mocked DB — no real orders, no real writes. Proves runOrderMarginCheck
// (controllers/shopifyWebhookController.js) correctly flags a line item
// priced below the real floor, correctly leaves a fine one alone, and
// correctly skips anything with no cost data on file (nothing to check
// against).
//
// Run from the backend repo root:
//   node scripts/testOrderMarginCheck.js

const Module = require("module");

function pass(label) {
  console.log(`PASS - ${label}`);
}
function fail(label, detail) {
  console.log(`FAIL - ${label}`);
  if (detail !== undefined) console.log("  ->", detail);
  process.exitCode = 1;
}

let auditLogs = [];

// variant-A: list 50000, cost 20000 -> floor = 20000/(1-0.2) = 25000
// variant-B: list 20000, cost 12000 -> floor = 12000/(1-0.2) = 15000
// variant-C: no cost on file at all -> must be skipped, not flagged
const fakeVariants = [
  { id: "v-a", shopifyVariantId: "9991", title: "Variant A" },
  { id: "v-b", shopifyVariantId: "9992", title: "Variant B" },
  { id: "v-c", shopifyVariantId: "9993", title: "Variant C" },
];
const fakeSupplierProducts = [
  { variantId: "v-a", isPrimary: true, costPrice: 20000 },
  { variantId: "v-b", isPrimary: true, costPrice: 12000 },
  // v-c deliberately has no SupplierProduct row at all
];

const fakePrisma = {
  variant: { findMany: async () => fakeVariants },
  supplierProduct: { findMany: async () => fakeSupplierProducts },
  auditLog: {
    create: async ({ data }) => {
      auditLogs.push(data);
      return data;
    },
  },
};

const fakeConfig = {
  margin: {
    bandThreshold: 100000,
    minBelow: 0.2,
    minAbove: 0.15,
    smoothing: { enabled: false, minProfit: 0 },
  },
  rounding: { below10k: 10, above10k: 100 },
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "../lib/prisma") return { prisma: fakePrisma };
  if (id.endsWith("pricingConfigLoader")) {
    return { loadPricingConfig: async () => fakeConfig };
  }
  if (id === "../services/membershipInviteService") {
    return { maybeSendMembershipInvite: async () => {} };
  }
  return originalRequire.apply(this, arguments);
};
const {
  runOrderMarginCheck,
} = require("../src/controllers/shopifyWebhookController");
Module.prototype.require = originalRequire;

async function main() {
  console.log("=== Order margin check test (mocked DB) ===\n");

  // Order with THREE line items:
  //   - variant A charged ₹20,000 (way below its ₹25,000 floor) -> should flag
  //   - variant B charged ₹18,000 (above its ₹15,000 floor) -> should NOT flag
  //   - variant C (no cost on file) charged ₹1 -> should be silently skipped
  const fakeOrder = {
    id: "order-1",
    orderNumber: "#1001",
    discountCodes: ["COTEST123"],
    lineItems: [
      {
        variant_id: 9991,
        title: "Variant A",
        price: "50000.00",
        quantity: 1,
        discount_allocations: [{ amount: "30000.00" }], // -> actual unit price 20000, floor 25000
      },
      {
        variant_id: 9992,
        title: "Variant B",
        price: "20000.00",
        quantity: 1,
        discount_allocations: [{ amount: "2000.00" }], // -> actual unit price 18000, floor 15000
      },
      {
        variant_id: 9993,
        title: "Variant C",
        price: "1.00",
        quantity: 1,
        discount_allocations: [],
      },
    ],
  };

  await runOrderMarginCheck(fakeOrder);

  console.log("AuditLog entries created:", JSON.stringify(auditLogs, null, 2));

  if (auditLogs.length !== 1) {
    fail(
      "exactly one AuditLog entry created (one violation, not three)",
      auditLogs.length,
    );
    return;
  }
  pass("exactly one AuditLog entry created");

  const entry = auditLogs[0];
  const violations = entry.afterState?.violations || [];
  if (
    entry.action === "order_below_floor_price" &&
    violations.length === 1 &&
    violations[0].shopifyVariantId === "9991" &&
    violations[0].actualUnitPrice === 20000 &&
    violations[0].floor === 25000
  ) {
    pass(
      "variant A correctly flagged (actual 20000 < floor 25000), variant B and C correctly left alone",
    );
  } else {
    fail(
      "variant A correctly flagged, variant B and C correctly left alone",
      entry,
    );
  }
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});
