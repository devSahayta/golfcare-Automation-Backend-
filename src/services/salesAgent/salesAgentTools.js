// src/services/salesAgent/salesAgentTools.js
const { prisma } = require("../../lib/prisma");
const { env } = require("../../config/env");

function buildSalesAgentTools(context) {
  const customerId = context.customer?.id || context.conversation.customerId;

  return {
    async search_products({ query, category, priceMin, priceMax, limit = 5 }) {
      // No embedding pipeline has been decided/built yet (open item —
      // the spec calls for pgvector similarity search, but nobody's
      // picked an embedding provider). This falls back to a keyword
      // match: split the query into words and match ANY of them against
      // title/vendor/tags, rather than requiring the whole query string
      // as one literal substring (which barely ever matches — variant
      // details like size/hand aren't in the product title). Category is
      // a soft filter tried alongside title, not required.
      // Swap this whole function for a prisma.$queryRaw pgvector <->
      // query once an embedding provider is decided; nothing else in the
      // codebase needs to change.
      const STOPWORDS = new Set([
        "size",
        "have",
        "any",
        "the",
        "you",
        "do",
        "for",
        "want",
        "need",
        "please",
        "looking",
        "get",
        "with",
        "and",
        "that",
        "this",
        "does",
        "your",
        "there",
        "hi",
        "hello",
        "can",
        "got",
        "golf", // "golf" is
        // on nearly every product's tags in this catalog — a near-useless
        // search term here even though it reads like a real one.
      ]);

      const words = query
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
        .slice(0, 6);

      // Cheap singularization — titles are singular ("... Driver"), but
      // the model often searches plural ("drivers"). Try both forms
      // rather than requiring an exact match either way.
      const wordForms = words.flatMap((w) =>
        w.length > 3 && w.toLowerCase().endsWith("s")
          ? [w, w.slice(0, -1)]
          : [w],
      );

      const textOr = wordForms.length
        ? wordForms.flatMap((w) => [
            { title: { contains: w, mode: "insensitive" } },
            { vendor: { contains: w, mode: "insensitive" } },
            { tags: { has: w } },
          ])
        : [{ title: { contains: query, mode: "insensitive" } }];

      const conditions = [{ OR: textOr }];
      if (category) {
        conditions.push({
          productType: { contains: category, mode: "insensitive" },
        });
      }
      if (priceMin != null || priceMax != null) {
        const priceCond = {};
        if (priceMin != null) priceCond.gte = priceMin;
        if (priceMax != null) priceCond.lte = priceMax;
        conditions.push({ priceMin: priceCond });
      }
      const where = { status: "active", AND: conditions };

      const products = await prisma.product.findMany({
        where,
        take: Math.min(limit, 10),
        include: { Variant: { take: 3 } },
      });

      return {
        results: products.map((p) => ({
          productId: p.id,
          title: p.title,
          priceMin: p.priceMin,
          priceMax: p.priceMax,
          imageUrl: p.imageUrls?.[0] || null,
          variants: p.Variant.map((v) => ({
            variantId: v.id,
            title: v.title,
            price: v.price,
          })),
        })),
      };
    },

    async get_product({ productId, variantId }) {
      if (variantId) {
        const variant = await prisma.variant.findUnique({
          where: { id: variantId },
          include: { Product: true },
        });
        if (!variant) return { error: "variant_not_found" };
        return { variant, product: variant.Product };
      }
      if (productId) {
        const product = await prisma.product.findUnique({
          where: { id: productId },
          include: { Variant: true },
        });
        if (!product) return { error: "product_not_found" };
        return { product };
      }
      return { error: "productId_or_variantId_required" };
    },

    async check_availability({ variantId }) {
      const state = await prisma.availabilityState.findUnique({
        where: { variantId },
      });
      if (!state)
        return { status: "UNKNOWN", source: null, lastCheckedAt: null };
      return {
        status: state.status,
        source: state.source,
        leadTimeDays: state.leadTimeDays,
        lastCheckedAt: state.confirmedAt,
      };
    },

    async get_customer_profile() {
      if (!customerId) {
        return {
          isMember: false,
          tier: null,
          unansweredQuestions: context.unansweredQuestions.map(
            (q) => q.fieldKey,
          ),
        };
      }
      return {
        isMember: context.customer.isMember,
        tier: context.customer.tier,
        budgetTier: context.golferProfile?.budgetTier || null,
        handicap: context.golferProfile?.handicap || null,
        preferredBrands: context.golferProfile?.preferredBrands || [],
        unansweredQuestions: context.unansweredQuestions.map((q) => q.fieldKey),
      };
    },

    async create_checkout_link({ variantIds, quantities }) {
      if (!variantIds?.length) return { error: "variantIds_required" };
      const variants = await prisma.variant.findMany({
        where: { id: { in: variantIds } },
      });
      if (variants.length !== variantIds.length)
        return { error: "one_or_more_variants_not_found" };

      const byId = Object.fromEntries(variants.map((v) => [v.id, v]));
      const parts = variantIds.map(
        (id, i) => `${byId[id].shopifyVariantId}:${quantities[i] || 1}`,
      );
      const totalInr = variantIds.reduce(
        (sum, id, i) => sum + Number(byId[id].price) * (quantities[i] || 1),
        0,
      );

      return {
        checkoutUrl: `https://${env.shopify.shopDomain}/cart/${parts.join(",")}`,
        totalInr,
      };
    },

    async escalate_to_human({ reason, urgency }) {
      await prisma.conversation.update({
        where: { id: context.conversation.id },
        data: { state: "AWAITING_HUMAN" },
      });
      await prisma.auditLog.create({
        data: {
          actorType: "AGENT",
          action: "escalated_to_human",
          entityType: "Conversation",
          entityId: context.conversation.id,
          afterState: { reason, urgency },
          source: "sales_agent",
        },
      });
      return { escalated: true };
    },

    async enroll_membership() {
      if (!customerId) return { error: "no_customer_on_conversation" };
      const memberCode = `GC${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      const consentText =
        "By enrolling, you agree Golf Care can contact you about your membership and orders on WhatsApp, per our privacy policy.";

      const updated = await prisma.customer.update({
        where: { id: customerId },
        data: {
          isMember: true,
          memberSince: new Date(),
          memberCode,
          consentMarketing: true,
          consentAt: new Date(),
          consentTextShown: consentText,
          onboardingState: "IN_PROGRESS",
          onboardingStartedAt: new Date(),
        },
      });
      return { enrolled: true, memberCode: updated.memberCode };
    },

    async record_profile_answer({ fieldKey, answer }) {
      if (!customerId) return { error: "no_customer_on_conversation" };

      await prisma.onboardingResponse.create({
        data: {
          customerId,
          conversationId: context.conversation.id,
          fieldKey,
          rawAnswer: answer,
          askedAt: new Date(),
          answeredAt: new Date(),
        },
      });

      // Only a few fields map onto typed GolferProfile columns today;
      // extend this map as more onboarding questions go live.
      const golferProfileUpdate = {};
      if (fieldKey === "handicap")
        golferProfileUpdate.handicap = parseInt(answer, 10) || null;
      if (fieldKey === "skillLevel") golferProfileUpdate.skillLevel = answer;
      if (fieldKey === "homeClub") golferProfileUpdate.homeClub = answer;

      await prisma.golferProfile.upsert({
        where: { customerId },
        create: { customerId, profileScore: 1, ...golferProfileUpdate },
        update: { profileScore: { increment: 1 }, ...golferProfileUpdate },
      });

      return { recorded: true };
    },
  };
}

module.exports = { buildSalesAgentTools };
