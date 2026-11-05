// scripts/testPhase5Controllers.js
//
// Mocked-DB test for the three new Phase 5 controllers (pricingConfig,
// offer, escalation) — no real DB writes, no real Shopify calls. Mocks
// ONLY "../lib/prisma" and "../services/pricingEngine/resolveVariantPricingInputs"
// (same Module.prototype.require interception pattern as
// testMakeOfferLogic.js / testCheckoutDiscountsLogic.js); the real
// pricingConfigLoader.js and computeEnvelope.js run unmocked so this also
// exercises the real assembleConfig()/computeFloorPrice() extraction.
//
// Calls each controller function directly with fake req/res objects
// (no express server, no supertest) and inspects what res.json() was
// called with.
//
// Run from the backend repo root:
//   node scripts/testPhase5Controllers.js

const Module = require("module");

function pass(label) {
  console.log(`PASS - ${label}`);
}
function fail(label, detail) {
  console.log(`FAIL - ${label}`);
  if (detail !== undefined)
    console.log("  ->", JSON.stringify(detail, null, 2));
  process.exitCode = 1;
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
}

// ---------------------------------------------------------------------
// Fake data
// ---------------------------------------------------------------------

let pricingConfigRows = [
  {
    key: "member.basePct",
    value: 10,
    updatedBy: "owner@test.com",
    updatedAt: new Date("2026-01-01"),
  },
];
let upsertCalls = [];

const fakeVariant = {
  id: "variant-1",
  shopifyVariantId: "9991",
  listPrice: 50000,
  costPrice: 20000,
  availabilityStatus: "IN_STOCK",
};
const fakeProduct = {
  id: "product-1",
  vendor: "TestBrand",
  productType: "Driver",
  pricingLocked: false,
  isSeasonal: false,
  supersededById: null,
};

const fakeOffers = [
  {
    id: "offer-1",
    conversationId: "conv-1",
    customerId: "cust-1",
    variantId: "variant-1",
    listPrice: 50000,
    offeredPrice: 43750,
    step: 1,
    status: "ACTIVE",
    floorAtOffer: 25000,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60),
    createdAt: new Date(),
  },
];

const fakeAuditLogs = [
  {
    id: "audit-1",
    action: "escalated_to_human",
    entityType: "Conversation",
    entityId: "conv-1",
    afterState: {
      reason: "customer wants more",
      urgency: "normal",
      offerContext: { variantId: "variant-1", currentOfferId: "offer-1" },
    },
    createdAt: new Date(),
  },
  {
    id: "audit-2",
    action: "escalated_to_human",
    entityType: "Conversation",
    entityId: "conv-2",
    afterState: {
      reason: "stock uncertain",
      urgency: "high",
      offerContext: null,
    },
    createdAt: new Date(),
  },
];

const fakeConversations = [
  {
    id: "conv-1",
    waPhone: "919999999991",
    state: "AI_HANDLING",
    Customer: {
      id: "cust-1",
      firstName: "Rahul",
      lastName: "Sharma",
      waPhone: "919999999991",
      memberCode: "GC000001",
      tier: "GOLD",
      ltvPercentile: 5,
    },
  },
  {
    id: "conv-2",
    waPhone: "919999999992",
    state: "AI_HANDLING",
    Customer: null,
  },
];

const fakePrisma = {
  pricingConfig: {
    findMany: async () => pricingConfigRows,
    upsert: async ({ where, create, update }) => {
      upsertCalls.push({ where, create, update });
      const idx = pricingConfigRows.findIndex((r) => r.key === where.key);
      if (idx >= 0)
        pricingConfigRows[idx] = { ...pricingConfigRows[idx], ...update };
      else pricingConfigRows.push({ key: where.key, ...create });
      return pricingConfigRows.find((r) => r.key === where.key);
    },
  },
  $transaction: async (promises) => Promise.all(promises),
  offer: {
    count: async () => fakeOffers.length,
    findMany: async ({ skip = 0, take = 25 }) =>
      fakeOffers.slice(skip, skip + take).map((o) => ({
        ...o,
        Customer: {
          id: "cust-1",
          firstName: "Rahul",
          lastName: "Sharma",
          waPhone: "919999999991",
          memberCode: "GC000001",
          tier: "GOLD",
        },
        Variant: {
          id: "variant-1",
          title: "Driver X",
          sku: "DRV-X",
          shopifyVariantId: "9991",
        },
      })),
  },
  auditLog: {
    count: async () => fakeAuditLogs.length,
    findMany: async ({ skip = 0, take = 25 }) =>
      fakeAuditLogs.slice(skip, skip + take),
  },
  conversation: {
    findMany: async ({ where }) =>
      fakeConversations.filter((c) => where.id.in.includes(c.id)),
  },
};

const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id.endsWith("lib/prisma")) return { prisma: fakePrisma };
  if (id.endsWith("resolveVariantPricingInputs")) {
    return {
      resolveVariantPricingInputs: async (ids) =>
        Object.fromEntries(
          ids.map((id) => [
            id,
            id === "variant-1"
              ? { variant: fakeVariant, product: fakeProduct }
              : { error: "variant_not_found" },
          ]),
        ),
    };
  }
  return originalRequire.apply(this, arguments);
};
const {
  listPricingConfig,
  updatePricingConfig,
  previewPricingConfig,
} = require("../src/controllers/pricingConfigController");
const { listOffers } = require("../src/controllers/offerController");
const { listEscalations } = require("../src/controllers/escalationController");
Module.prototype.require = originalRequire;

async function main() {
  console.log("=== Phase 5 controller tests (mocked DB) ===\n");

  // --- listPricingConfig: every DEFAULTS key present, override flagged ---
  {
    const res = fakeRes();
    await listPricingConfig({ query: {} }, res);
    const row = res.body.data.find((r) => r.key === "member.basePct");
    const defaultedRow = res.body.data.find(
      (r) => r.key === "ceiling.maxTotalPct",
    );
    if (
      res.statusCode === 200 &&
      row &&
      row.isDefault === false &&
      row.updatedBy === "owner@test.com" &&
      defaultedRow &&
      defaultedRow.isDefault === true
    ) {
      pass(
        `listPricingConfig: ${res.body.total} keys returned, DB override flagged correctly, untouched key falls back to DEFAULTS`,
      );
    } else {
      fail("listPricingConfig: override vs default flagging", res.body);
    }
  }

  // --- updatePricingConfig: rejects unknown key ------------------------
  {
    const res = fakeRes();
    await updatePricingConfig(
      {
        body: { changes: [{ key: "not.a.real.key", value: 1 }] },
        staffUser: { email: "owner@test.com" },
      },
      res,
    );
    if (res.statusCode === 400) {
      pass("updatePricingConfig: rejects an unknown config key with 400");
    } else {
      fail("updatePricingConfig: rejects an unknown config key", res.body);
    }
  }

  // --- updatePricingConfig: valid upsert, cache invalidated -------------
  {
    const res = fakeRes();
    upsertCalls = [];
    await updatePricingConfig(
      {
        body: { changes: [{ key: "member.basePct", value: 12 }] },
        staffUser: { email: "owner@test.com" },
      },
      res,
    );
    if (
      res.statusCode === 200 &&
      upsertCalls.length === 1 &&
      upsertCalls[0].update.value === 12 &&
      upsertCalls[0].update.updatedBy === "owner@test.com"
    ) {
      pass(
        "updatePricingConfig: valid change upserted with correct staff identity",
      );
    } else {
      fail("updatePricingConfig: valid change upserted", {
        body: res.body,
        upsertCalls,
      });
    }
  }

  // --- previewPricingConfig: before uses current DB value, after uses proposed ---
  {
    const res = fakeRes();
    // currentFlat has member.basePct = 12 now (from the upsert above) —
    // proposed change pushes it to 20, isolated from everything else.
    await previewPricingConfig(
      {
        body: {
          variantId: "variant-1",
          changes: [{ key: "member.basePct", value: 20 }],
        },
      },
      res,
    );
    if (res.statusCode !== 200) {
      fail("previewPricingConfig: 200 response", res.body);
    } else {
      const { before, after } = res.body;
      // before: list 50000, basePct 12% -> memberPrice 44000 (rounded to nearest 100 above 10k)
      // after:  list 50000, basePct 20% -> memberPrice 40000
      if (
        before.memberPrice === 44000 &&
        after.memberPrice === 40000 &&
        before._full &&
        after._full
      ) {
        pass(
          `previewPricingConfig: before (${before.memberPrice}) vs after (${after.memberPrice}) reflect the proposed basePct change, _full present for staff view`,
        );
      } else {
        fail("previewPricingConfig: before/after reflect proposed change", {
          before,
          after,
        });
      }
    }
  }

  // --- previewPricingConfig: unknown variant -> 404 ----------------------
  {
    const res = fakeRes();
    await previewPricingConfig(
      {
        body: {
          variantId: "does-not-exist",
          changes: [{ key: "member.basePct", value: 20 }],
        },
      },
      res,
    );
    if (res.statusCode === 404) {
      pass("previewPricingConfig: unknown variant returns 404");
    } else {
      fail("previewPricingConfig: unknown variant returns 404", res.body);
    }
  }

  // --- listOffers: pagination shape + joined Customer/Variant ------------
  {
    const res = fakeRes();
    await listOffers({ query: {} }, res);
    if (
      res.statusCode === 200 &&
      res.body.total === 1 &&
      res.body.data[0].Customer?.memberCode === "GC000001" &&
      res.body.data[0].Variant?.sku === "DRV-X"
    ) {
      pass(
        "listOffers: returns {data, page, limit, total, totalPages} with Customer/Variant joined",
      );
    } else {
      fail("listOffers: response shape and joins", res.body);
    }
  }

  // --- listEscalations: enriches with Customer + Offer + live floor/cost ---
  {
    const res = fakeRes();
    await listEscalations({ query: {} }, res);
    const withOffer = res.body.data.find((e) => e.id === "audit-1");
    const withoutOffer = res.body.data.find((e) => e.id === "audit-2");
    // variant-1: cost 20000, list 50000 (>= bandThreshold 100000? no, below it)
    // -> minMargin = minBelow (0.25 from pricingConfigLoader DEFAULTS, since
    // no DB row overrides margin.minBelow) -> floor = 20000/(1-0.25) = 26666.67
    // -> roundUpFriendly -> 26700 (above-10k increments of 100)
    if (
      res.statusCode === 200 &&
      withOffer?.customer?.waPhone === "919999999991" &&
      withOffer?.offer?.id === "offer-1" &&
      withOffer?.liveCost === 20000 &&
      withOffer?.liveFloor === 26700 &&
      withoutOffer?.offer === null &&
      withoutOffer?.customer === null
    ) {
      pass(
        `listEscalations: audit-1 enriched with customer + offer + live floor (${withOffer.liveFloor}); audit-2 (no offerContext, no linked customer) correctly left null`,
      );
    } else {
      fail("listEscalations: enrichment", res.body);
    }
  }
}

main().catch((err) => {
  console.error("Script crashed:", err);
  process.exit(1);
});
