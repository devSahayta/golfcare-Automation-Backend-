// src/services/salesAgent/salesAgentTools.js
const { prisma } = require("../../lib/prisma");
const { env } = require("../../config/env");
const {
  classifyBallBudgetTier,
  mapSkillLevel,
  mapPlayFrequency,
  mapGloveHand,
  mapMarketingConsent,
  ENROLMENT_QUESTIONS,
} = require("./enrolmentQuestions");

const ENROLMENT_FIELD_KEYS = ENROLMENT_QUESTIONS.map((q) => q.fieldKey);

// Module-level — must be reachable from enroll_membership, not scoped
// inside search_products.
const CONSENT_NOTICE_V1 =
  "Membership is free — it gets you member pricing, first access to new stock, and a golf expert on this number whenever you need one. May we send you occasional offers and reminders on WhatsApp? You can stop any time by replying STOP.";

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
      // details like size/hand aren't in the product title).
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

      // category used to be a hard AND filter against productType only —
      // but productType values are always specific ("Drivers", "Irons",
      // "Fairway Woods"), never a broad word like "clubs" or "gloves"
      // (those only exist as tags). A model-guessed category like "clubs"
      // therefore matched zero rows even when real products existed,
      // silently telling customers something wasn't stocked when it was.
      // Folding category into the general keyword list makes it a SOFT
      // signal like any other search word — it still helps narrow
      // results via title/vendor/tag matching, but can never by itself
      // zero out a search that should have real hits.
      const combinedQuery = category ? `${query} ${category}` : query;

      const words = combinedQuery
        .replace(/[^\w\s']/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
        .slice(0, 8);

      // Cheap singularization — titles are singular ("... Driver"), but
      // the model often searches plural ("drivers"). Try both forms
      // rather than requiring an exact match either way.
      const wordForms = words.flatMap((w) =>
        w.length > 3 && w.toLowerCase().endsWith("s")
          ? [w, w.slice(0, -1)]
          : [w],
      );

      if (!wordForms.length) {
        return { results: [] };
      }

      // Explicit gender filter — a real AND condition, not just another
      // OR keyword. Generic words like "shoes" match both genders'
      // titles equally, so without this, a "men's" query still surfaces
      // women's results whenever they happen to rank first with no
      // relevance ordering. Uses startsWith, not contains: "Women's"
      // literally contains the substring "men's" inside it (wo-MEN'S),
      // so a naive contains check would wrongly match both genders.
      const lowerCombined = combinedQuery.toLowerCase();
      let genderFilter = null;
      if (
        /\bmen'?s\b/.test(lowerCombined) &&
        !/\bwomen'?s\b/.test(lowerCombined)
      ) {
        genderFilter = { title: { startsWith: "Men's", mode: "insensitive" } };
      } else if (
        /\bwomen'?s\b/.test(lowerCombined) ||
        /\bladies\b/.test(lowerCombined)
      ) {
        genderFilter = {
          title: { startsWith: "Women's", mode: "insensitive" },
        };
      }
      const genderConditions = genderFilter ? [genderFilter] : [];

      const priceConditions = [];
      if (priceMin != null || priceMax != null) {
        const priceCond = {};
        if (priceMin != null) priceCond.gte = priceMin;
        if (priceMax != null) priceCond.lte = priceMax;
        priceConditions.push({ priceMin: priceCond });
      }

      // Two-tier search: a query like "Callaway fairway wood" should
      // prefer products whose TITLE actually says "fairway wood" over
      // products that only match because the vendor is "Callaway" — a
      // vendor-only match is true for all ~136 Callaway products in this
      // catalog, so without this tiering, a brand name alone can swamp
      // out genuinely relevant title matches with no way to tell them
      // apart (no relevance ranking on a plain OR query).
      const titleOr = wordForms.map((w) => ({
        title: { contains: w, mode: "insensitive" },
      }));
      let usedWhere = {
        status: "active",
        AND: [{ OR: titleOr }, ...priceConditions, ...genderConditions],
      };
      let products = await prisma.product.findMany({
        where: usedWhere,
        take: Math.min(limit, 15),
        include: { Variant: { take: 3 } },
      });

      // Fall back to the broader vendor/tags-inclusive search only if the
      // stricter title-first pass found nothing — preserves support for
      // vague/brand-only browsing ("show me Callaway stuff") without
      // letting it dominate more specific queries.
      if (products.length === 0) {
        const broadOr = wordForms.flatMap((w) => [
          { title: { contains: w, mode: "insensitive" } },
          { vendor: { contains: w, mode: "insensitive" } },
          { tags: { has: w } },
        ]);
        usedWhere = {
          status: "active",
          AND: [{ OR: broadOr }, ...priceConditions, ...genderConditions],
        };
        products = await prisma.product.findMany({
          where: usedWhere,
          take: Math.min(limit, 15),
          include: { Variant: { take: 3 } },
        });
      }

      // Total match count (not just what's shown) — lets the model
      // honestly offer "want to see more?" instead of guessing whether
      // more exist, or worse, implying these 5 are all there is.
      const totalCount = await prisma.product.count({ where: usedWhere });

      return {
        results: products.map((p) => ({
          productId: p.id,
          title: p.title,
          priceMin: p.priceMin,
          priceMax: p.priceMax,
          imageUrl: p.imageUrls?.[0] || null,
          productUrl: `https://${env.shopify.shopDomain}/products/${p.handle}`,
          variants: p.Variant.map((v) => ({
            variantId: v.id,
            title: v.title,
            price: v.price,
          })),
        })),
        totalCount,
        moreAvailable: totalCount > products.length,
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

    // enroll_membership — no longer asks for marketing consent upfront.
    // Consent is now the LAST Part A question (marketingConsent), asked
    // once trust is already built through the setup conversation, not
    // cold before the customer knows anything about you. This also fixes
    // the old double-name-ask bug: this tool used to be preceded by an
    // ad-hoc name+consent mini-flow outside the deterministic question
    // list, which had no fixed field key for the model to use when
    // recording the name — hence it sometimes guessed wrong keys. Now
    // there's exactly one path: agree to join -> enroll immediately ->
    // Part A list handles everything, including consent, in order.
    async enroll_membership() {
      if (!customerId) return { error: "no_customer_on_conversation" };

      // Idempotency guard — the model can and does call this tool more than
      // once in a conversation (e.g. forgetting it already enrolled the
      // customer mid-setup). Never regenerate a code or reset onboarding
      // progress for an existing member — that silently orphans old codes
      // and confuses the customer about which code is real.
      if (context.customer?.isMember) {
        return {
          enrolled: true,
          memberCode: context.customer.memberCode,
          alreadyEnrolled: true,
        };
      }

      // Deterministic guard — the model sometimes short-circuits straight
      // from a bare invite ("have you thought about joining?") to
      // enrolling on a single "yes", skipping the actual STEP 2 benefits
      // explanation entirely. Prompt wording alone hasn't reliably
      // prevented this, so it's enforced here: don't allow enrollment
      // until a message containing the real pitch (member pricing bullet)
      // has actually been sent in this conversation.
      const pitchSent = (context.recentMessages || []).some(
        (m) =>
          m.sender === "AI_AGENT" && /member pricing|🏷️/.test(m.body || ""),
      );
      if (!pitchSent) {
        return {
          error: "benefits_not_yet_explained",
          hint: "You haven't actually explained what membership is yet — only sent a bare invite. Explain the benefits (bullet points) and ask a clear 'want to join?' question first, THEN call this tool again once they agree to that.",
        };
      }

      const memberCode = `GC${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

      const updated = await prisma.customer.update({
        where: { id: customerId },
        data: {
          isMember: true,
          memberSince: new Date(),
          memberCode,
          consentMarketing: false, // not asked yet — set properly when marketingConsent is answered at the end
          consentTextShown: CONSENT_NOTICE_V1,
          consentVersion: "v1",
          onboardingState: "IN_PROGRESS",
          onboardingStartedAt: new Date(),
        },
      });
      return {
        enrolled: true,
        memberCode: updated.memberCode,
      };
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

      const golferProfileUpdate = {};

      if (fieldKey === "firstName") {
        await prisma.customer.update({
          where: { id: customerId },
          data: { firstName: answer },
        });
      }

      if (fieldKey === "homeClub") golferProfileUpdate.homeClub = answer;

      if (fieldKey === "handicap") {
        golferProfileUpdate.handicap = parseInt(answer, 10) || null;
      }

      // Enum fields — must go through mappers, raw text will throw a
      // Prisma invalid-enum-value error.
      if (fieldKey === "skillLevel") {
        const mapped = mapSkillLevel(answer);
        if (mapped) golferProfileUpdate.skillLevel = mapped;
        else golferProfileUpdate.handicap = parseInt(answer, 10) || null; // they gave an exact number instead of a band
      }
      if (fieldKey === "playFrequency") {
        const mapped = mapPlayFrequency(answer);
        if (mapped) golferProfileUpdate.playFrequency = mapped;
      }
      if (fieldKey === "gloveHand") {
        const mapped = mapGloveHand(answer);
        if (mapped) golferProfileUpdate.gloveHand = mapped;
      }

      // Free-text fields — fine as raw strings.
      if (fieldKey === "gloveSize") golferProfileUpdate.gloveSize = answer;

      if (fieldKey === "currentBallModel") {
        golferProfileUpdate.currentBallModel = answer;
        const tier = classifyBallBudgetTier(answer);
        if (tier) {
          golferProfileUpdate.budgetTier = tier;
          golferProfileUpdate.budgetTierSource = "DECLARED";
        }
      }

      // marketingConsent — the final Part A question. This is the actual
      // DPDP consent gate; it just lives at the end of setup now instead
      // of before the customer knows anything about the business. Updates
      // Customer directly (not GolferProfile) and records consentAt here,
      // the real moment consent was captured.
      if (fieldKey === "marketingConsent") {
        const consented = mapMarketingConsent(answer) === true; // ambiguous answers default to false, never assume yes
        await prisma.customer.update({
          where: { id: customerId },
          data: { consentMarketing: consented, consentAt: new Date() },
        });
      }

      if (Object.keys(golferProfileUpdate).length) {
        await prisma.golferProfile.upsert({
          where: { customerId },
          create: { customerId, profileScore: 1, ...golferProfileUpdate },
          update: { profileScore: { increment: 1 }, ...golferProfileUpdate },
        });
      }

      // Deterministic completion — do NOT rely on the model remembering to
      // call complete_enrolment separately. The moment every Part A field
      // (including marketingConsent, the last one) has actually been
      // recorded, flip onboardingState here and signal it in the return
      // value. This return value is exactly what guardrails.js checks
      // before allowing the member code to be revealed — without this,
      // that guardrail blocks the completion message forever, since its
      // conditions can never become true any other way.
      if (ENROLMENT_FIELD_KEYS.includes(fieldKey)) {
        const answered = await prisma.onboardingResponse.findMany({
          where: { customerId, fieldKey: { in: ENROLMENT_FIELD_KEYS } },
          select: { fieldKey: true },
        });
        const answeredSet = new Set(answered.map((a) => a.fieldKey));
        const allDone = ENROLMENT_FIELD_KEYS.every((k) => answeredSet.has(k));
        if (allDone) {
          await prisma.customer.update({
            where: { id: customerId },
            data: {
              onboardingState: "COMPLETED",
              onboardingCompletedAt: new Date(),
            },
          });
          return { recorded: true, enrolmentCompleted: true };
        }
      }

      return { recorded: true };
    },

    // Fires once every Part A enrolment field has been answered/skipped.
    // Uses the real enum value (COMPLETED) and real Customer fields —
    // no enrolmentCompletedAt on GolferProfile, that was scoped out.
    async complete_enrolment() {
      if (!customerId) return { error: "no_customer_on_conversation" };
      await prisma.customer.update({
        where: { id: customerId },
        data: {
          onboardingState: "COMPLETED",
          onboardingCompletedAt: new Date(),
        },
      });
      return { completed: true };
    },
  };
}

module.exports = { buildSalesAgentTools };
