// src/controllers/pricingConfigController.js
//
// Phase 5 — owner-facing pricing config console. Three endpoints:
//
//   GET  /api/pricing-config          List every known key (DB value or
//                                      DEFAULTS fallback), so the UI always
//                                      shows a complete settings form —
//                                      never a sparse one that's missing a
//                                      row just because nobody's edited it
//                                      yet. isDefault tells the frontend
//                                      whether to show "(default)" or an
//                                      actual override badge.
//
//   PUT  /api/pricing-config          Bulk upsert: body { changes: [{key,
//                                      value}] }. Invalidates the 60s
//                                      pricingConfigLoader cache so the
//                                      change is live for the very next
//                                      get_price_envelope/make_offer call,
//                                      not after waiting out the TTL.
//
//   POST /api/pricing-config/preview  Option A (confirmed) — single real
//                                      product, before/after. Body
//                                      { variantId, changes: [{key,
//                                      value}] }. Computed with a FIXED
//                                      synthetic customer (isMember:true,
//                                      tier:"STANDARD", ltvPercentile:null)
//                                      and no cart/campaigns, so the number
//                                      is reproducible and never depends on
//                                      which real customer or cart happens
//                                      to be in view — a staff member
//                                      comparing two candidate values needs
//                                      a stable baseline. This is the
//                                      staff-only screen, so the full
//                                      envelope (including _full — cost,
//                                      floor, levers) is returned; nothing
//                                      is stripped the way it is before
//                                      reaching the sales agent.
//
// Staff identity: requireStaffAuth (middleware/kindeAuth.js) attaches the
// full StaffUser row to req.staffUser after verifying the Kinde JWT and
// looking it up by kindeUserId — confirmed against the real file, so
// req.staffUser.email is always present on any request that got past
// that middleware.

const { prisma } = require("../lib/prisma");
const {
  loadPricingConfig,
  invalidatePricingConfigCache,
  assembleConfig,
  DEFAULTS,
} = require("../services/pricingEngine/pricingConfigLoader");
const {
  resolveVariantPricingInputs,
} = require("../services/pricingEngine/resolveVariantPricingInputs");
const {
  computeEnvelope,
} = require("../services/pricingEngine/computeEnvelope");

function staffIdentity(req) {
  return req.staffUser.email;
}

function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return "changes must be a non-empty array of {key, value}";
  }
  for (const change of changes) {
    if (
      !change ||
      typeof change.key !== "string" ||
      change.value === undefined
    ) {
      return "each change needs a string key and a value";
    }
    if (!(change.key in DEFAULTS)) {
      return `unknown pricing config key: ${change.key}`;
    }
  }
  return null;
}

async function listPricingConfig(req, res) {
  try {
    const rows = await prisma.pricingConfig.findMany();
    const byKey = new Map(rows.map((r) => [r.key, r]));

    const data = Object.keys(DEFAULTS).map((key) => {
      const row = byKey.get(key);
      return {
        key,
        value: row ? row.value : DEFAULTS[key],
        isDefault: !row,
        updatedBy: row ? row.updatedBy : null,
        updatedAt: row ? row.updatedAt : null,
      };
    });

    res.json({ data, total: data.length });
  } catch (err) {
    console.error("listPricingConfig failed:", err);
    res.status(500).json({ error: "Failed to load pricing config" });
  }
}

async function updatePricingConfig(req, res) {
  try {
    const { changes } = req.body;
    const validationError = validateChanges(changes);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const updatedBy = staffIdentity(req);
    await prisma.$transaction(
      changes.map((change) =>
        prisma.pricingConfig.upsert({
          where: { key: change.key },
          create: { key: change.key, value: change.value, updatedBy },
          update: { value: change.value, updatedBy },
        }),
      ),
    );

    invalidatePricingConfigCache();

    res.json({ ok: true, updated: changes.map((c) => c.key) });
  } catch (err) {
    console.error("updatePricingConfig failed:", err);
    res.status(500).json({ error: "Failed to update pricing config" });
  }
}

async function previewPricingConfig(req, res) {
  try {
    const { variantId, changes } = req.body;
    if (!variantId || typeof variantId !== "string") {
      return res.status(400).json({ error: "variantId is required" });
    }
    const validationError = validateChanges(changes);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    const resolved = await resolveVariantPricingInputs([variantId]);
    const entry = resolved[variantId];
    if (!entry || entry.error) {
      return res.status(404).json({ error: "variant not found" });
    }

    const rows = await prisma.pricingConfig.findMany();
    const currentFlat = { ...DEFAULTS };
    for (const row of rows) currentFlat[row.key] = row.value;

    const proposedFlat = { ...currentFlat };
    for (const change of changes) proposedFlat[change.key] = change.value;

    const beforeConfig = assembleConfig(currentFlat);
    const afterConfig = assembleConfig(proposedFlat);

    const syntheticCustomer = {
      isMember: true,
      tier: "STANDARD",
      ltvPercentile: null,
    };
    const now = new Date();

    const before = computeEnvelope({
      variant: entry.variant,
      product: entry.product,
      customer: syntheticCustomer,
      cart: null,
      activeCampaigns: [],
      now,
      config: beforeConfig,
    });
    const after = computeEnvelope({
      variant: entry.variant,
      product: entry.product,
      customer: syntheticCustomer,
      cart: null,
      activeCampaigns: [],
      now,
      config: afterConfig,
    });

    res.json({
      variantId,
      product: {
        id: entry.product.id,
        vendor: entry.product.vendor,
        productType: entry.product.productType,
      },
      syntheticCustomer,
      before,
      after,
    });
  } catch (err) {
    console.error("previewPricingConfig failed:", err);
    res.status(500).json({ error: "Failed to compute preview" });
  }
}

module.exports = {
  listPricingConfig,
  updatePricingConfig,
  previewPricingConfig,
};
