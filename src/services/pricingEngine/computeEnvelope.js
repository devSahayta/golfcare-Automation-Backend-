// computeEnvelope.js
//
// Pure function. No I/O, no Prisma, no Shopify calls — callers resolve
// cost (via SupplierProduct.isPrimary), customer, cart and config and
// pass them in; this just does the arithmetic and returns the envelope.
//
// Config shape expected (nested, not the flat PricingConfig rows —
// Phase 3's config loader assembles this from the DB):
//
// {
//   member: { basePct, floorMode },
//   margin: { bandThreshold, minBelow, minAbove, smoothing: { enabled, minProfit } },
//   ceiling: { maxTotalPct },
//   lever: {
//     richMargin: { minListMargin, pct },
//     oldModel: { pct },
//     offSeason: { months: [startMonth, endMonth], pct },
//     tier: { STANDARD, SILVER, GOLD, PLATINUM },
//     ltv: { topPercentile, pct },
//     bundle: { minItems, minOrderValue, pct },
//   },
//   ladder: { steps: [0.4, 0.75, 1.0], thinRoom: { minRupees, minPct } },
//   agent: { maxOrderForLevers },
//   rounding: { below10k, above10k },
//   discounting: { enabled },
// }
//
// NOTE: the original spec's "aged stock" and "overstock" levers are
// deliberately NOT implemented here — Golf Care is pure dropship and
// holds no stock itself, so there is no inventory that can age or pile
// up. The only stock signal that matters is AvailabilityState.status
// (confirmed by the supplier during check-ins); see the availabilityStatus
// gate in computeLeverSum below.

function roundUpFriendly(amount, rounding) {
  const increment = amount < 10000 ? rounding.below10k : rounding.above10k;
  // Epsilon guard: 30000 * 0.82 is 24600.000000000004 in float64, not
  // exactly 24600 — without this, Math.ceil bumps an exact multiple up
  // a full increment it shouldn't. 1e-6 is far smaller than a paisa on
  // any real rupee amount this function sees.
  return Math.ceil(amount / increment - 1e-6) * increment;
}

function computeLeverSum({
  variant,
  product,
  customer,
  cart,
  activeCampaigns,
  now,
  config,
}) {
  const levers = {};

  // Golf Care holds no stock itself (pure dropship) — there's no
  // "aged/overstock inventory sitting in a warehouse" scenario, so
  // those two levers from the original spec don't exist here at all.
  // The only stock question that matters: did the supplier actually
  // confirm this is available right now? If not (OUT_OF_STOCK,
  // ON_ORDER, DISCONTINUED, or never checked/UNKNOWN), don't negotiate
  // at all — you can't safely discount something you can't confirm
  // you can fulfil.
  if (variant.availabilityStatus !== "IN_STOCK") {
    return { sum: 0, applied: [] };
  }

  // Rich margin — list-price margin high enough to afford extra room.
  if (variant.costPrice != null) {
    const listMargin =
      1 - Number(variant.costPrice) / Number(variant.listPrice);
    if (listMargin >= config.lever.richMargin.minListMargin) {
      levers.richMargin = config.lever.richMargin.pct;
    }
  }

  // Old model — a newer model of the same product line exists.
  if (product.supersededById) {
    levers.oldModel = config.lever.oldModel.pct;
  }

  // Off-season — skips seasonal products entirely.
  if (!product.isSeasonal) {
    const [startMonth, endMonth] = config.lever.offSeason.months;
    const month = now.getMonth() + 1; // JS months are 0-indexed
    if (month >= startMonth && month <= endMonth) {
      levers.offSeason = config.lever.offSeason.pct;
    }
  }

  // Tier — flat lookup.
  const tierPct = config.lever.tier[customer.tier] || 0;
  if (tierPct > 0) levers.tier = tierPct;

  // LTV — top percentile of customers.
  if (
    customer.ltvPercentile != null &&
    customer.ltvPercentile <= config.lever.ltv.topPercentile
  ) {
    levers.ltv = config.lever.ltv.pct;
  }

  // Bundle — multiple items, big enough order.
  if (cart && cart.lines && cart.lines.length >= config.lever.bundle.minItems) {
    const cartTotal = cart.lines.reduce(
      (sum, l) => sum + l.unitListPrice * l.qty,
      0,
    );
    if (cartTotal >= config.lever.bundle.minOrderValue) {
      levers.bundle = config.lever.bundle.pct;
    }
  }

  // Campaigns — single highest matching campaign only, don't stack.
  if (activeCampaigns && activeCampaigns.length) {
    const matching = activeCampaigns.filter((c) =>
      campaignMatches(c, product, variant),
    );
    if (matching.length) {
      const best = matching.reduce((a, b) =>
        Number(b.percent) > Number(a.percent) ? b : a,
      );
      levers.campaign = Number(best.percent);
    }
  }

  const sum = Object.values(levers).reduce((a, b) => a + b, 0);
  const applied = Object.entries(levers).map(([name, pct]) => ({ name, pct }));
  return { sum, applied };
}

// Pulled out of computeEnvelope so the Phase 4 order-webhook margin
// check (controllers/shopifyWebhookController.js) can recompute the
// exact same floor from just costPrice/listPrice/config — no customer,
// cart, or levers needed, since the floor itself never depends on any
// of those. Keeping this as the ONE place the floor formula lives means
// the webhook check can never silently drift out of sync with what
// get_price_envelope/make_offer actually enforced at quote time.
function computeFloorPrice({ costPrice, listPrice, config }) {
  const minMargin =
    listPrice < config.margin.bandThreshold
      ? config.margin.minBelow
      : config.margin.minAbove;
  let floor = costPrice / (1 - minMargin);
  if (
    config.margin.smoothing.enabled &&
    listPrice >= config.margin.bandThreshold
  ) {
    floor = Math.max(floor, costPrice + config.margin.smoothing.minProfit);
  }
  return roundUpFriendly(floor, config.rounding);
}

function campaignMatches(campaign, product, variant) {
  const scope = campaign.scope || {};
  if (scope.productIds && !scope.productIds.includes(product.id)) return false;
  if (scope.vendors && !scope.vendors.includes(product.vendor)) return false;
  if (scope.productTypes && !scope.productTypes.includes(product.productType))
    return false;
  if (scope.tags && !(product.tags || []).some((t) => scope.tags.includes(t)))
    return false;
  return true;
}

function computeEnvelope(input) {
  const { variant, product, customer, cart, activeCampaigns, now, config } =
    input;

  const listPrice = Number(variant.listPrice);
  const rounding = config.rounding;

  // 1. Short-circuit.
  if (!customer.isMember) {
    return {
      variantId: variant.id,
      listPrice,
      memberPrice: listPrice,
      lowestAgentPrice: listPrice,
      suggestedSteps: [],
      thinRoom: true,
      canEscalateForMore: false,
      _full: {
        costPrice: null,
        floorPrice: null,
        maxDiscountPct: 0,
        leversApplied: [],
        belowFloorAtList: false,
      },
    };
  }
  if (
    variant.costPrice == null ||
    product.pricingLocked ||
    config.discounting.enabled === false
  ) {
    const memberPrice = roundUpFriendly(
      listPrice * (1 - config.member.basePct / 100),
      rounding,
    );
    return {
      variantId: variant.id,
      listPrice,
      memberPrice,
      lowestAgentPrice: memberPrice,
      suggestedSteps: [],
      thinRoom: true,
      canEscalateForMore: false,
      _full: {
        costPrice: variant.costPrice != null ? Number(variant.costPrice) : null,
        floorPrice: null,
        maxDiscountPct: 0,
        leversApplied: [],
        belowFloorAtList: false,
      },
    };
  }

  const costPrice = Number(variant.costPrice);
  const basePct = config.member.basePct / 100;

  // 2-3. Min margin band + floor — see computeFloorPrice above, the one
  // place this formula lives.
  const floor = computeFloorPrice({ costPrice, listPrice, config });

  // 4. Max discount.
  const maxDiscountPct = Math.max(0, 1 - floor / listPrice);

  // 5. Member price.
  let memberPrice = listPrice * (1 - basePct);
  let belowFloorAtList = false;
  if (config.member.floorMode === "margin_wins") {
    if (floor > listPrice) {
      memberPrice = listPrice;
      belowFloorAtList = true;
    } else if (memberPrice < floor) {
      memberPrice = floor;
    }
  }
  // member_wins: memberPrice stays at the flat 10% off, even below floor.
  // The order webhook's margin check is what catches that case at checkout.
  memberPrice = roundUpFriendly(memberPrice, rounding);

  // 6. Levers.
  const { sum: leverSum, applied: leversApplied } = computeLeverSum({
    variant,
    product,
    customer,
    cart,
    activeCampaigns,
    now,
    config,
  });

  // 7. Allowed price.
  const targetPct =
    Math.min(basePct * 100 + leverSum, config.ceiling.maxTotalPct) / 100;
  let allowed = Math.max(listPrice * (1 - targetPct), floor);
  allowed = Math.min(allowed, memberPrice);
  allowed = roundUpFriendly(allowed, rounding);
  // Rounding up can occasionally push `allowed` a touch above memberPrice
  // when they land in different rounding buckets — reclamp so the lowest
  // price offered is never above the member price itself.
  allowed = Math.min(allowed, memberPrice);

  // 8. Room and steps.
  const room = memberPrice - allowed;
  // Both conditions have to hold for room to count as "thin" — a big
  // high-ticket item can have a small room *percentage* while still
  // being a meaningful rupee amount worth stepping through (case 3:
  // room is 1.9% of member price but ₹2,800 is real negotiating room).
  const thinRoom =
    room < config.ladder.thinRoom.minRupees &&
    (memberPrice === 0 ||
      (room / memberPrice) * 100 < config.ladder.thinRoom.minPct);

  let suggestedSteps = [];
  if (!thinRoom) {
    suggestedSteps = config.ladder.steps.map((share) =>
      roundUpFriendly(memberPrice - room * share, rounding),
    );
  }

  // 9. High-ticket.
  const cartValue =
    cart && cart.lines
      ? cart.lines.reduce((sum, l) => sum + l.unitListPrice * l.qty, 0)
      : listPrice;
  let canEscalateForMore = false;
  if (cartValue > config.agent.maxOrderForLevers) {
    suggestedSteps = suggestedSteps.slice(0, 1);
    canEscalateForMore = true;
  }

  // 10. Escalation flag.
  if (
    allowed > floor &&
    (customer.tier === "GOLD" || customer.tier === "PLATINUM")
  ) {
    canEscalateForMore = true;
  }

  return {
    variantId: variant.id,
    listPrice,
    memberPrice,
    lowestAgentPrice: allowed,
    suggestedSteps,
    thinRoom,
    canEscalateForMore,
    _full: {
      costPrice,
      floorPrice: floor,
      maxDiscountPct,
      leversApplied,
      belowFloorAtList,
    },
  };
}

module.exports = { computeEnvelope, roundUpFriendly, computeFloorPrice };
