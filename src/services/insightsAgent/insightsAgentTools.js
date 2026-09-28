// src/services/insightsAgent/insightsAgentTools.js
//
// Every tool here is read-only, by design (see insightsAgentConfig.js's
// system prompt) — this agent answers questions about the business, it
// never writes anything. No conversationId/customerId scoping needed
// (unlike salesAgentTools/supplierAgentTools) since this isn't tied to a
// WhatsApp conversation — it's a stateless staff-facing query each call.

const { prisma } = require("../../lib/prisma");

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

// Splits a query into words and matches on ANY of them, rather than
// requiring the whole phrase as one exact substring. A single punctuation
// mismatch (curly vs straight apostrophe, an extra hyphen) shouldn't be
// able to block an otherwise-obviously-correct match on a full product
// name — this is what makes that forgiving. Returns undefined (no filter)
// when the query is empty, so callers can pass it straight into `where`.
function wordsOf(query) {
  return (query || "")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

function buildOrClause(query, fields) {
  const words = wordsOf(query);
  if (words.length === 0) return undefined;
  return words.flatMap((word) =>
    fields.map((field) => ({
      [field]: { contains: word, mode: "insensitive" },
    })),
  );
}

function buildInsightsAgentTools() {
  return {
    async get_top_selling_products({ days = 7, limit = 5 }) {
      const since = daysAgo(days);
      const orders = await prisma.order.findMany({
        where: { placedAt: { gte: since } },
        select: { lineItems: true },
        take: 1000, // safety cap, not expected to bind in practice
      });

      // Shopify's raw line-item shape varies by field naming across API
      // versions — read defensively rather than assuming one exact shape.
      const totals = new Map();
      for (const order of orders) {
        const items = Array.isArray(order.lineItems) ? order.lineItems : [];
        for (const item of items) {
          const title = item.title || item.name || "Unknown item";
          const qty = Number(item.quantity ?? item.qty ?? 1);
          const price = Number(item.price ?? item.unit_price ?? 0);
          const existing = totals.get(title) || {
            title,
            unitsSold: 0,
            revenue: 0,
          };
          existing.unitsSold += qty;
          existing.revenue += qty * price;
          totals.set(title, existing);
        }
      }

      const ranked = [...totals.values()]
        .sort((a, b) => b.unitsSold - a.unitsSold)
        .slice(0, limit);
      return {
        windowDays: days,
        ordersConsidered: orders.length,
        topProducts: ranked,
      };
    },

    async get_suppliers_needing_attention({ limit = 5 }) {
      const [lowReliability, problemChecks] = await Promise.all([
        prisma.supplier.findMany({
          where: { isActive: true, reliabilityScore: { lt: 80 } },
          orderBy: { reliabilityScore: "asc" },
          take: limit,
          select: {
            id: true,
            name: true,
            reliabilityScore: true,
            avgResponseMins: true,
          },
        }),
        prisma.supplierCheck.findMany({
          where: {
            status: { in: ["TIMED_OUT", "ESCALATED"] },
            sentAt: { gte: daysAgo(14) },
          },
          orderBy: { sentAt: "desc" },
          take: limit * 2,
          include: {
            Supplier: { select: { id: true, name: true, isActive: true } },
          },
        }),
      ]);

      const flagged = new Map();
      for (const s of lowReliability) {
        flagged.set(s.id, {
          supplierId: s.id,
          name: s.name,
          reliabilityScore: s.reliabilityScore,
          reason: `Reliability score ${s.reliabilityScore}/100`,
        });
      }
      for (const check of problemChecks) {
        if (!check.Supplier?.isActive) continue;
        const key = check.Supplier.id;
        const existing = flagged.get(key);
        const reasonNote = `${check.status === "TIMED_OUT" ? "Timed out" : "Escalated"} stock check on ${check.sentAt.toISOString().slice(0, 10)}`;
        if (existing) {
          existing.reason += `; ${reasonNote}`;
        } else {
          flagged.set(key, {
            supplierId: key,
            name: check.Supplier.name,
            reliabilityScore: null,
            reason: reasonNote,
          });
        }
      }

      return { suppliers: [...flagged.values()].slice(0, limit) };
    },

    async get_customers_due_followup({ limit = 5 }) {
      const cutoff = daysAgo(45);
      const customers = await prisma.customer.findMany({
        where: {
          isMember: true,
          OR: [{ lastOrderAt: null }, { lastOrderAt: { lt: cutoff } }],
        },
        orderBy: { lifetimeValue: "desc" },
        take: limit,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          waPhone: true,
          tier: true,
          lifetimeValue: true,
          lastOrderAt: true,
        },
      });

      return {
        cutoffDays: 45,
        customers: customers.map((c) => ({
          customerId: c.id,
          name:
            [c.firstName, c.lastName].filter(Boolean).join(" ") || c.waPhone,
          phone: c.waPhone,
          tier: c.tier,
          lifetimeValue: c.lifetimeValue,
          daysSinceLastOrder: c.lastOrderAt
            ? Math.floor(
                (Date.now() - new Date(c.lastOrderAt).getTime()) / 86400000,
              )
            : null,
        })),
      };
    },

    async search_customers({ query, limit = 10 }) {
      const orClause = buildOrClause(query, [
        "firstName",
        "lastName",
        "email",
        "waPhone",
      ]);
      const customers = await prisma.customer.findMany({
        where: orClause ? { OR: orClause } : undefined, // no query = list, not "match nothing"
        orderBy: { createdAt: "desc" },
        take: limit,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          waPhone: true,
          tier: true,
          lifetimeValue: true,
          isMember: true,
        },
      });
      return { customers, mode: query ? "search" : "list" };
    },

    async search_products({ query, limit = 10 }) {
      const orClause = buildOrClause(query, ["title", "vendor", "productType"]);
      const products = await prisma.product.findMany({
        where: orClause ? { OR: orClause } : undefined,
        orderBy: { syncedAt: "desc" },
        take: limit,
        select: {
          id: true,
          title: true,
          vendor: true,
          productType: true,
          priceMin: true,
          priceMax: true,
          status: true,
        },
      });
      return { products, mode: query ? "search" : "list" };
    },

    async search_suppliers({ query, limit = 10 }) {
      const orClause = buildOrClause(query, ["name", "waPhone"]);
      const suppliers = await prisma.supplier.findMany({
        where: orClause ? { OR: orClause } : undefined,
        orderBy: { reliabilityScore: "desc" },
        take: limit,
        select: {
          id: true,
          name: true,
          reliabilityScore: true,
          isActive: true,
          brands: true,
        },
      });
      return { suppliers, mode: query ? "search" : "list" };
    },

    async find_customers_for_price_range({ minPrice, maxPrice, limit = 10 }) {
      // Check the catalog-wide gap first, not just within this price
      // range — if literally no product anywhere has a tierLevel, that's
      // the real, specific reason this can't work, for any price range,
      // and the agent should say exactly that instead of hedging.
      const taggedProductCount = await prisma.product.count({
        where: { tierLevel: { not: null } },
      });
      if (taggedProductCount === 0) {
        return {
          supported: false,
          note: "No product in the catalog has a budget tier (tierLevel) assigned yet — this isn't specific to this price range, it's true catalog-wide. This kind of question can't be answered until products get tagged with a tier.",
        };
      }

      // Ground this in real product prices rather than hardcoding tier
      // boundaries nobody has actually defined anywhere in the schema —
      // find which budget tiers your catalog actually prices into this
      // range, then match customers on that.
      const matchingProducts = await prisma.product.findMany({
        where: {
          tierLevel: { not: null },
          OR: [
            { priceMin: { gte: minPrice, lte: maxPrice } },
            { priceMax: { gte: minPrice, lte: maxPrice } },
            {
              AND: [
                { priceMin: { lte: minPrice } },
                { priceMax: { gte: maxPrice } },
              ],
            },
          ],
        },
        select: { tierLevel: true },
        distinct: ["tierLevel"],
      });

      const tiers = matchingProducts.map((p) => p.tierLevel).filter(Boolean);
      if (tiers.length === 0) {
        return {
          supported: true,
          tiersFound: [],
          customers: [],
          note: "Some products in the catalog do have a budget tier assigned, but none of those tagged products fall in this specific price range.",
        };
      }

      const customers = await prisma.customer.findMany({
        where: { GolferProfile: { budgetTier: { in: tiers } } },
        orderBy: { lifetimeValue: "desc" },
        take: limit,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          waPhone: true,
          tier: true,
          lifetimeValue: true,
          GolferProfile: { select: { budgetTier: true } },
        },
      });

      return { supported: true, tiersFound: tiers, customers };
    },
  };
}

// Logs every tool call with its arguments and whether it succeeded — this
// is what lets you verify which tool Haiku actually picked while testing,
// rather than inferring it from the reply text alone. Cheap enough to
// leave on permanently; if it gets noisy later, gate it behind an env var.
function withLogging(handlers) {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, fn]) => [
      name,
      async (args) => {
        const label = `[insights tool] ${name}(${JSON.stringify(args || {})})`;
        try {
          const result = await fn(args);
          console.log(`${label} -> ok`);
          return result;
        } catch (err) {
          console.error(`${label} -> FAILED: ${err.message}`);
          throw err;
        }
      },
    ]),
  );
}

module.exports = {
  buildInsightsAgentTools: () => withLogging(buildInsightsAgentTools()),
};
