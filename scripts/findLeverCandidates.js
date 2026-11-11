// scripts/findLeverCandidates.js
//
// READ-ONLY — no writes, no Shopify calls. Lists real in-stock variants
// with known cost, sorted by margin descending, and shows how far each
// is from qualifying for the richMargin lever under the CURRENT live
// config. Purpose: pick the real product for the Phase 5/WhatsApp
// negotiation-ladder test with the smallest possible config tweak — e.g.
// if the best candidate has margin 0.38 and richMargin.minListMargin is
// currently 0.45, we only need to drop the threshold to ~0.35, not
// invent a huge change.
//
// Run from the backend repo root:
//   node scripts/findLeverCandidates.js

const { prisma } = require("../src/lib/prisma");
const {
  loadPricingConfig,
} = require("../src/services/pricingEngine/pricingConfigLoader");

async function main() {
  const config = await loadPricingConfig();
  console.log(
    `Current lever.richMargin: minListMargin=${config.lever.richMargin.minListMargin}, pct=${config.lever.richMargin.pct}`,
  );
  console.log(
    `Current margin.bandThreshold=${config.margin.bandThreshold}, minBelow=${config.margin.minBelow}, minAbove=${config.margin.minAbove}`,
  );
  console.log(
    `Current ladder.thinRoom: minRupees=${config.ladder.thinRoom.minRupees}, minPct=${config.ladder.thinRoom.minPct}\n`,
  );

  const [variants, supplierProducts, availabilityStates] = await Promise.all([
    prisma.variant.findMany({ include: { Product: true } }),
    prisma.supplierProduct.findMany({ where: { isPrimary: true } }),
    prisma.availabilityState.findMany({ where: { status: "IN_STOCK" } }),
  ]);

  const costByVariantId = new Map(
    supplierProducts
      .filter((sp) => sp.variantId)
      .map((sp) => [sp.variantId, sp.costPrice]),
  );
  const inStockVariantIds = new Set(availabilityStates.map((a) => a.variantId));

  const candidates = [];
  for (const v of variants) {
    if (!inStockVariantIds.has(v.id)) continue;
    const costPrice = costByVariantId.get(v.id);
    if (costPrice == null) continue;
    if (v.Product.pricingLocked) continue;

    const listPrice = Number(v.price);
    const cost = Number(costPrice);
    if (listPrice <= 0) continue;
    const margin = 1 - cost / listPrice;

    // Rough floor estimate (ignores smoothing, just to sanity-check this
    // product even has room between member price and floor at all).
    const minMargin =
      listPrice < config.margin.bandThreshold
        ? config.margin.minBelow
        : config.margin.minAbove;
    const estFloor = cost / (1 - minMargin);
    const memberPrice = listPrice * (1 - config.member.basePct / 100);

    candidates.push({
      variantId: v.id,
      shopifyVariantId: v.shopifyVariantId,
      title: `${v.Product.title} — ${v.title}`,
      sku: v.sku,
      listPrice,
      cost,
      margin,
      estFloor,
      memberPrice,
      roomEstimate: memberPrice - estFloor,
      qualifiesRichMargin: margin >= config.lever.richMargin.minListMargin,
    });
  }

  candidates.sort((a, b) => b.margin - a.margin);

  console.log(
    `${candidates.length} in-stock variants with known cost, sorted by margin (highest first):\n`,
  );
  console.log(
    "margin   | qualifies? | room est | list     | cost     | SKU        | title",
  );
  for (const c of candidates.slice(0, 20)) {
    console.log(
      `${(c.margin * 100).toFixed(1).padStart(6)}% | ${c.qualifiesRichMargin ? "YES       " : "no        "} | ₹${c.roomEstimate.toFixed(0).padStart(6)} | ₹${c.listPrice.toFixed(0).padStart(7)} | ₹${c.cost.toFixed(0).padStart(7)} | ${(c.sku || "—").padEnd(10)} | ${c.title}`,
    );
  }

  const bestNonQualifying = candidates.find((c) => !c.qualifiesRichMargin);
  if (bestNonQualifying) {
    console.log(
      `\nBest near-miss: "${bestNonQualifying.title}" at ${(bestNonQualifying.margin * 100).toFixed(1)}% margin — ` +
        `lowering lever.richMargin.minListMargin to ${Math.floor(bestNonQualifying.margin * 100) / 100} would qualify it ` +
        `(variantId: ${bestNonQualifying.variantId}, shopifyVariantId: ${bestNonQualifying.shopifyVariantId}).`,
    );
  }
}

main()
  .catch((err) => {
    console.error("Script crashed:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
