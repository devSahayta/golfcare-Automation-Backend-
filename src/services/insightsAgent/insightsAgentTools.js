// src/services/insightsAgent/insightsAgentTools.js
//
// Two classes of tools live here:
//   1. Read-only query tools — look up products, customers, suppliers.
//   2. Campaign tools:
//        preview_audience       — read-only, shows who would be reached
//        suggest_campaign_content — read-only, generates 3 message variants (NO DB write)
//        draft_campaign         — writes a DRAFT BroadcastCampaign row
//
//   NEW FLOW: The agent calls preview_audience → suggest_campaign_content only.
//   draft_campaign is now called by the FRONTEND directly (via REST) when the
//   staff member clicks "Save Draft" on the content picker card in the widget.
//   The agent never calls draft_campaign itself.

const Anthropic = require("@anthropic-ai/sdk");
const { prisma } = require("../../lib/prisma");
const { buildAudience, MAX_AUDIENCE } = require("../broadcastAudienceService");
const { env } = require("../../config/env");

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000);
}

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

// ── Content generation for suggest_campaign_content ──────────────────────────
//
// Uses a separate Haiku call (cheap — 3 short messages) to write the variants.
// Returns { variants: [{ label, bodyText, tone, headerType, headerText, headerImagePromptHint, footerText, buttons }], recommendedIndex: number }

const CONTENT_GEN_PROMPT = `You write WhatsApp message variants for Golf Care, a golf equipment retailer in India.

Given a campaign intent, context, and any specific requests (like "add a header", "add an image", "add buttons", "add a footer"), write exactly 3 message variants.

Each variant has these fields:
- bodyText (required): starts with "Hi {{1}},", up to 900 characters after the greeting
- label (required): "Recommended", "Direct", or "Conversational"
- tone (required): one sentence describing this variant's approach
- headerType (required): "IMAGE" for a photographic golf scene image, "TEXT" if a short text header helps, otherwise "NONE"
- headerText: short header text if headerType is "TEXT" (max 60 chars, plain text, no variables, no emojis)
- headerImagePromptHint: ONLY when headerType is "IMAGE" — a short phrase describing the golf scene that best fits this campaign (e.g. "championship golf course golden hour", "golf equipment on grass", "putting green sunrise"). No text, no logos, no people's faces. Max 15 words.
- footerText: short footer line if requested or appropriate (max 60 chars, e.g. "Reply STOP to opt out")
- buttons: array of up to 2 quick-reply button objects if requested, e.g. [{"type":"QUICK_REPLY","text":"Count me in"},{"type":"QUICK_REPLY","text":"Not interested"}]

Rules for bodyText:
- Start with "Hi {{1}},"
- Natural, conversational tone — write like a person, not a brand
- Include ALL relevant details from context (dates, venue, phone numbers, offers, etc.)
- Soft CTA: "reply here", "visit us", "call us at [number if provided]"
- Max one emoji per variant, placed naturally
- NEVER use: ALL CAPS words, "click here", "act now", "don't miss out", "limited time only"

When to use each headerType:
- headerType "IMAGE": use for EVENT, ANNOUNCEMENT, PROMOTIONAL intents where a photographic golf scene would make the message stand out. This generates a real AI photo — best for visual impact. Set headerImagePromptHint to describe the scene (no text, no logos).
- headerType "TEXT" + headerText: use when a short title label helps clarity but an image isn't needed, OR when the user/context explicitly asks for a text header.
- headerType "NONE": for simple, personal messages where a header would feel too formal.

Meta image rules (important — the AI image must pass Meta review):
- headerImagePromptHint must describe a CLEAN OUTDOOR GOLF SCENE ONLY
- No text, no words, no signs in the image
- No logos, no branding
- No promotional elements (prices, banners, sale text)
- Natural lighting, photorealistic style

footerText and buttons:
- footerText: when the user/context explicitly asks, OR for PROMOTIONAL intents (best practice: "Reply STOP to opt out")
- buttons: when user/context explicitly asks, OR for EVENT intents with a clear RSVP action
- If not asked and not clearly helpful, omit/null footerText and buttons

Variant strategy:
- Variant 1 (label: "Recommended"): Best overall — include components where they genuinely help. Most likely to get Meta approval. Prefer IMAGE header for visually strong campaigns.
- Variant 2 (label: "Direct"): Concise and fact-forward. Minimal components — TEXT header only if clearly needed, no image.
- Variant 3 (label: "Conversational"): Warmer and more personal. No header. Softer CTA.

Respond ONLY with valid JSON — no explanation, no markdown fences, just the raw JSON object:
{
  "variants": [
    {
      "label": "Recommended",
      "tone": "one sentence describing this variant's approach",
      "bodyText": "Hi {{1}}, ...",
      "headerType": "IMAGE",
      "headerText": null,
      "headerImagePromptHint": "championship golf course golden hour fairway",
      "footerText": "Reply STOP to opt out",
      "buttons": [{"type": "QUICK_REPLY", "text": "Count me in"}, {"type": "QUICK_REPLY", "text": "Not this time"}]
    },
    {
      "label": "Direct",
      "tone": "one sentence describing this variant's approach",
      "bodyText": "Hi {{1}}, ...",
      "headerType": "TEXT",
      "headerText": "Golf Care Tournament",
      "headerImagePromptHint": null,
      "footerText": null,
      "buttons": null
    },
    {
      "label": "Conversational",
      "tone": "one sentence describing this variant's approach",
      "bodyText": "Hi {{1}}, ...",
      "headerType": "NONE",
      "headerText": null,
      "headerImagePromptHint": null,
      "footerText": null,
      "buttons": null
    }
  ],
  "recommendedIndex": 0
}`;

async function generateContentVariants({
  intent,
  context,
  campaignName,
  preferredHeaderType = null,
}) {
  const client = new Anthropic({ apiKey: env.anthropicApiKey });

  // Build a hard directive line when staff explicitly chose a header type
  let headerDirective = "";
  if (preferredHeaderType === "IMAGE") {
    headerDirective = `\nSTAFF REQUIREMENT: The staff member explicitly requested an IMAGE header. Variant 1 (Recommended) MUST use headerType "IMAGE" with a valid headerImagePromptHint. Do not override this.`;
  } else if (preferredHeaderType === "TEXT") {
    headerDirective = `\nSTAFF REQUIREMENT: The staff member explicitly requested a TEXT header. Variant 1 (Recommended) MUST use headerType "TEXT" with a suitable headerText. Do not override this.`;
  } else if (preferredHeaderType === "NONE") {
    headerDirective = `\nSTAFF REQUIREMENT: The staff member explicitly requested NO header. Variant 1 (Recommended) MUST use headerType "NONE". Do not override this.`;
  }

  const userMessage = `Campaign name: ${campaignName}
Intent: ${intent}
Context: ${context || "No additional context provided."}${headerDirective}

Write 3 message variants following the JSON schema exactly.`;

  const response = await client.messages.create({
    model: env.anthropicModelHaiku,
    max_tokens: 1800,
    system: CONTENT_GEN_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const raw = response.content[0]?.text || "";

  // Parse JSON — strip any accidental markdown fences
  const cleaned = raw
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "")
    .trim();
  const parsed = JSON.parse(cleaned);

  return {
    variants: parsed.variants,
    recommendedIndex: parsed.recommendedIndex ?? 0,
    tokensUsed: response.usage,
  };
}

function buildInsightsAgentTools({ staffUserId = null } = {}) {
  return {
    async get_top_selling_products({ days = 7, limit = 5 }) {
      const since = daysAgo(days);
      const orders = await prisma.order.findMany({
        where: { placedAt: { gte: since } },
        select: { lineItems: true },
        take: 1000,
      });

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
        where: orClause ? { OR: orClause } : undefined,
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
      const taggedProductCount = await prisma.product.count({
        where: { tierLevel: { not: null } },
      });
      if (taggedProductCount === 0) {
        return {
          supported: false,
          note: "No product in the catalog has a budget tier (tierLevel) assigned yet.",
        };
      }

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
          note: "No tagged products in this price range.",
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

    // ── Campaign tools ────────────────────────────────────────────────

    /**
     * preview_audience — show who would receive a campaign without creating anything.
     * Read-only. Always call this FIRST.
     */
    async preview_audience({ rules = {} }) {
      const result = await buildAudience(rules);
      const samples = result.customers.slice(0, 5).map((c) => ({
        name: [c.firstName, c.lastName].filter(Boolean).join(" ") || c.waPhone,
        city: c.city || null,
        tier: c.tier,
      }));
      return {
        eligibleCount: result.customers.length,
        excludedNoConsent: result.excludedNoConsent,
        excludedOptedOut: result.excludedOptedOut,
        totalMatched: result.totalMatched,
        capped: result.capped,
        capLimit: MAX_AUDIENCE,
        sampleCustomers: samples,
        rules,
      };
    },

    /**
     * suggest_campaign_content — generate 3 message variants WITHOUT saving to DB.
     * Called after preview_audience confirms the audience.
     *
     * Each variant now includes:
     *   headerType: "IMAGE" | "TEXT" | "NONE"
     *   headerText: string | null           (for TEXT headers)
     *   headerImagePromptHint: string | null (for IMAGE headers — passed to imageGenerationService at submit time)
     *   footerText: string | null
     *   buttons: array | null
     *
     * The frontend shows these as selectable cards. When the staff member picks one
     * and clicks "Save Draft", the frontend calls PATCH /api/campaigns/:id/template.
     * The IMAGE header is generated at submit time (POST /submit), not at draft time.
     */
    async suggest_campaign_content({
      campaignName,
      intent,
      context = "",
      audienceRules,
      audienceSize,
      preferredHeaderType = null,
    }) {
      if (!campaignName || !intent || !audienceRules) {
        return {
          success: false,
          error: "campaignName, intent, and audienceRules are required",
        };
      }
      if (audienceSize === 0) {
        return {
          success: false,
          error: "Audience is empty — cannot suggest content for 0 recipients.",
        };
      }

      const generated = await generateContentVariants({
        intent,
        context,
        campaignName,
        preferredHeaderType,
      });

      return {
        success: true,
        campaignName,
        audienceRules,
        audienceSize,
        intent,
        variants: generated.variants,
        // variants: { label, tone, bodyText, headerType, headerText, headerImagePromptHint, footerText, buttons }
        recommendedIndex: generated.recommendedIndex,
        // Signal to the frontend to show the content picker card
        action: "SHOW_CONTENT_PICKER",
      };
    },

    /**
     * draft_campaign — save a DRAFT BroadcastCampaign and its recipient list.
     * NOTE: In the NEW flow, this is called by the FRONTEND via REST (POST /api/campaigns/draft),
     * not by the agent. It remains here as a fallback if called, but the agent's system prompt
     * instructs it never to call this.
     */
    async draft_campaign({ name, bodyText, audienceRules, agentPrompt = "" }) {
      if (!name || !bodyText || !audienceRules) {
        return {
          success: false,
          error: "name, bodyText, and audienceRules are all required",
        };
      }

      const audienceResult = await buildAudience(audienceRules);
      if (audienceResult.customers.length === 0) {
        return {
          success: false,
          error: "No eligible customers match these rules.",
          excludedNoConsent: audienceResult.excludedNoConsent,
          excludedOptedOut: audienceResult.excludedOptedOut,
        };
      }

      const baseName = name
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/[^a-z0-9_]/g, "")
        .slice(0, 40);
      const templateName = `${baseName}_${Date.now()}`;

      const campaign = await prisma.$transaction(async (tx) => {
        const c = await tx.broadcastCampaign.create({
          data: {
            name,
            templateName,
            bodyText,
            audienceRules,
            audienceSize: audienceResult.customers.length,
            agentPrompt,
            createdByStaffId: staffUserId || null,
            status: "DRAFT",
          },
        });

        await tx.broadcastRecipient.createMany({
          data: audienceResult.customers.map((cust) => ({
            campaignId: c.id,
            customerId: cust.id,
            phone: cust.waPhone,
            firstName: cust.firstName || null,
            status: "PENDING",
          })),
        });

        return c;
      });

      return {
        success: true,
        campaignId: campaign.id,
        campaignName: campaign.name,
        templateName: campaign.templateName,
        audienceSize: audienceResult.customers.length,
        bodyText: campaign.bodyText,
        action: "SHOW_CAMPAIGN_CARD",
      };
    },
  };
}

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
  buildInsightsAgentTools: (opts = {}) =>
    withLogging(buildInsightsAgentTools(opts)),
};
