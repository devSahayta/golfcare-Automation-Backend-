// src/services/broadcastAudienceService.js
//
// Resolves a customer audience from a flexible rule set for broadcast
// campaigns. Rules are authored by the Insights agent via the
// draft_campaign tool and stored in BroadcastCampaign.audienceRules.
//
// ALL audience resolution goes through this single file so consent,
// opt-out, and deduplication are enforced in exactly one place, not
// scattered across agent tools and campaign endpoints.
//
// Rule shape (all fields optional):
// {
//   productKeywords: ["ball", "Pro V1"],   // match order line item titles
//   orderWithinDays: 60,                   // placed in last N days
//   lastOrderMinDays: 90,                  // for win-back: no order for N+ days
//   tiers: ["GOLD", "PLATINUM"],           // Customer.tier
//   budgetTiers: ["MID", "PREMIUM"],       // GolferProfile.budgetTier
//   cities: ["Chennai", "Bengaluru"],      // Customer.city (case-insensitive)
//   hand: "LEFT",                          // GolferProfile.dominantHand
//   isMember: true,                        // Customer.isMember
//   limit: 200,                            // hard cap (default + max = 200)
// }

const { prisma } = require("../lib/prisma");

const MAX_AUDIENCE = 200;

/**
 * @param {object} rules
 * @returns {Promise<{
 *   customers: Array<{id,firstName,lastName,waPhone,tier,city}>,
 *   excludedNoConsent: number,
 *   excludedOptedOut: number,
 *   totalMatched: number,
 *   capped: boolean,
 * }>}
 */
async function buildAudience(rules = {}) {
  const {
    productKeywords = [],
    orderWithinDays,
    lastOrderMinDays,
    tiers = [],
    budgetTiers = [],
    cities = [],
    hand,
    isMember,
    limit = MAX_AUDIENCE,
  } = rules;

  const cap = Math.min(Number(limit) || MAX_AUDIENCE, MAX_AUDIENCE);

  // ── 1. Build where clause ─────────────────────────────────────────────
  const where = {};

  // isMember filter
  if (isMember === true || isMember === false) {
    where.isMember = isMember;
  }

  // Customer tier filter
  if (tiers.length > 0) {
    where.tier = { in: tiers };
  }

  // City filter — case-insensitive
  if (cities.length > 0) {
    where.OR = (where.OR || []).concat(
      cities.map((c) => ({ city: { contains: c, mode: "insensitive" } })),
    );
  }

  // Win-back: no order in last N days
  if (lastOrderMinDays && lastOrderMinDays > 0) {
    const cutoff = new Date(
      Date.now() - lastOrderMinDays * 24 * 60 * 60 * 1000,
    );
    where.OR = (where.OR || []).concat([
      { lastOrderAt: null },
      { lastOrderAt: { lt: cutoff } },
    ]);
  }

  // GolferProfile filters (budgetTier, dominantHand)
  if (budgetTiers.length > 0 || hand) {
    const profileWhere = {};
    if (budgetTiers.length > 0) profileWhere.budgetTier = { in: budgetTiers };
    if (hand) profileWhere.dominantHand = hand;
    where.GolferProfile = profileWhere;
  }

  // ── 2. If product keywords specified, find matching customerIds first ─
  if (productKeywords.length > 0 && orderWithinDays > 0) {
    const since = new Date(Date.now() - orderWithinDays * 24 * 60 * 60 * 1000);
    const recentOrders = await prisma.order.findMany({
      where: {
        placedAt: { gte: since },
        customerId: { not: null },
      },
      select: { customerId: true, lineItems: true },
      take: 5000, // safety cap
    });

    // Find customerIds whose orders contain any keyword match
    const keywordsLower = productKeywords.map((k) => k.toLowerCase());
    const matchingCustomerIds = new Set();
    for (const order of recentOrders) {
      const items = Array.isArray(order.lineItems) ? order.lineItems : [];
      const hasMatch = items.some((item) => {
        const title = (item.title || item.name || "").toLowerCase();
        return keywordsLower.some((kw) => title.includes(kw));
      });
      if (hasMatch && order.customerId) {
        matchingCustomerIds.add(order.customerId);
      }
    }

    if (matchingCustomerIds.size === 0) {
      return {
        customers: [],
        excludedNoConsent: 0,
        excludedOptedOut: 0,
        totalMatched: 0,
        capped: false,
      };
    }
    where.id = { in: [...matchingCustomerIds] };
  } else if (orderWithinDays > 0 && productKeywords.length === 0) {
    // Any order in the window, no product keyword filter
    const since = new Date(Date.now() - orderWithinDays * 24 * 60 * 60 * 1000);
    where.lastOrderAt = { gte: since };
  }

  // ── 3. Fetch ALL matching customers (including excluded ones for counts) ─
  const all = await prisma.customer.findMany({
    where,
    orderBy: { lifetimeValue: "desc" },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      waPhone: true,
      tier: true,
      city: true,
      consentMarketing: true,
      optedOutAt: true,
    },
    take: MAX_AUDIENCE * 5, // fetch more so we can count exclusions
  });

  // ── 4. Apply consent / opt-out filter ─────────────────────────────────
  let excludedNoConsent = 0;
  let excludedOptedOut = 0;
  const eligible = [];

  for (const c of all) {
    if (c.optedOutAt) {
      excludedOptedOut += 1;
      continue;
    }
    if (!c.consentMarketing) {
      excludedNoConsent += 1;
      continue;
    }
    eligible.push(c);
  }

  const capped = eligible.length > cap;
  const customers = eligible.slice(0, cap);

  return {
    customers,
    excludedNoConsent,
    excludedOptedOut,
    totalMatched: all.length,
    capped,
  };
}

module.exports = { buildAudience, MAX_AUDIENCE };
