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
    async search_products({
      query,
      category,
      vendor,
      priceMin,
      priceMax,
      limit = 5,
    }) {
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

      // Gender words are handled ONLY via the dedicated genderFilter
      // below (a precise startsWith AND condition) — they must NOT also
      // appear in the generic OR keyword list. Almost every product in
      // this catalog is prefixed "Men's ..." or "Women's ...", so if a
      // gender word is allowed to count as a standalone OR match, it
      // alone is enough to match trousers, polos, caps, gloves —
      // anything men's-branded — swamping the actual product-type words
      // (shoes, spikeless, driver, etc.) that should be doing the real
      // narrowing. This bit us directly: "men's spikeless shoes" started
      // matching "Men's Tech Trousers" purely off the word "men's".
      const GENDER_WORDS = new Set([
        "men's",
        "men",
        "mens",
        "women's",
        "women",
        "womens",
        "ladies",
        "junior's",
        "juniors",
        "kids",
      ]);

      // Orientation words are handled ONLY via the dedicated
      // orientationFilter below, for the exact same reason as
      // GENDER_WORDS above — "left"/"right"/"hand" appear constantly in
      // completely unrelated product titles (e.g. "0211 Hellcat Putter
      // -Black Hand-Right/Length-34 Inches", "Men's M8 Steel Golf Set -
      // Left Hand..."), since club handedness is encoded in titles the
      // same way glove handedness is. Left in the generic OR keyword
      // pool, these words alone are enough to match putters, full club
      // sets, and belts ahead of the actual gloves being searched for —
      // this is exactly the bug that surfaced when a customer asked for
      // "left hand black leather" gloves and got putters back instead.
      const ORIENTATION_WORDS = new Set([
        "left",
        "right",
        "hand",
        "handed",
        "lefty",
        "righty",
      ]);

      // Color words are handled ONLY via the dedicated colorFilter below,
      // for the same reason as GENDER_WORDS/ORIENTATION_WORDS — color
      // usually lives in Variant.title ("Sky Blue", "Red", "Brown / UK
      // 10"), not Product.title, so a color word left in the generic OR
      // keyword pool matches ~zero titles and does nothing, while a
      // co-occurring generic word ("cap", "shoe") matches nearly the
      // whole category regardless of color. Declared up here (used by
      // the `words` filter below) even though the actual colorFilter
      // condition is built further down, once lowerCombined exists.
      const COLOR_WORDS = [
        "black",
        "white",
        "red",
        "blue",
        "navy",
        "green",
        "grey",
        "gray",
        "pink",
        "orange",
        "yellow",
        "purple",
        "brown",
        "silver",
        "gold",
        "tan",
        "charcoal",
        "lavender",
        "maroon",
        "turquoise",
        "beige",
        "teal",
        "olive",
        "cream",
        "coral",
        "khaki",
      ];

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
        .filter(
          (w) =>
            w.length > 2 &&
            !STOPWORDS.has(w.toLowerCase()) &&
            !GENDER_WORDS.has(w.toLowerCase()) &&
            !ORIENTATION_WORDS.has(w.toLowerCase()) &&
            !COLOR_WORDS.includes(w.toLowerCase()),
        )
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

      // Explicit orientation filter — same shape as genderFilter, but
      // checks BOTH Product.title and Variant.title, since this catalog
      // is inconsistent about where handedness actually lives: some
      // products encode it on the variant ("Left hand / Large"), others
      // on the product itself ("...Glove - Right Hand", confirmed via
      // the Dawn Patrol glove — no hand info on any of its variants at
      // all). Checking only one location silently excludes real matches
      // stored the other way, so this is an OR across both, applied as
      // a real AND condition on the query as a whole.
      let orientationFilter = null;
      if (/\bleft\b/.test(lowerCombined)) {
        orientationFilter = {
          OR: [
            { title: { contains: "Left Hand", mode: "insensitive" } },
            {
              Variant: {
                some: { title: { contains: "Left hand", mode: "insensitive" } },
              },
            },
          ],
        };
      } else if (/\bright\b/.test(lowerCombined)) {
        orientationFilter = {
          OR: [
            { title: { contains: "Right Hand", mode: "insensitive" } },
            {
              Variant: {
                some: {
                  title: { contains: "Right hand", mode: "insensitive" },
                },
              },
            },
          ],
        };
      }
      // Explicit vendor/brand filter — a real AND condition against
      // Product.vendor, not a keyword in the generic OR pool. Brand
      // names essentially never appear inside this catalog's product
      // titles (e.g. "Men's Torque 2 MD Spiked Golf Shoes" has no
      // "FootJoy" in it even though vendor="FootJoy"), so a brand word
      // left in the generic keyword list matches ~zero titles and
      // contributes nothing — while other generic words in the same
      // query ("shoe", "shoes", "glove") match almost the entire
      // category regardless of brand. Net effect without this filter:
      // "FootJoy shoes" silently returns shoes of every brand. This is
      // populated from the dedicated `vendor` tool argument — the model
      // is instructed to pass a named brand there, not just fold it
      // into `query`.
      const vendorConditions = vendor
        ? [{ vendor: { contains: vendor, mode: "insensitive" } }]
        : [];

      // Explicit color filter — checks BOTH Product.title and
      // Variant.title, for the exact same reason as orientation above.
      // Proven necessary by real data: most black spiked shoes in this
      // catalog have color ONLY in Product.title ("...Golf Shoes -
      // Black") with a bare "UK 9" variant title carrying no color at
      // all — a Variant-title-only filter silently excluded every one
      // of them (5 of 7 real matches for "black spiked UK 9" were
      // dropped), while the 1-2 products that happen to bake color into
      // the variant title ("UK 9 / Black") passed through fine. COLOR_WORDS
      // itself is declared earlier (needed by the `words` filter above);
      // this builds the actual condition once lowerCombined is available.
      const requestedColor = COLOR_WORDS.find((c) =>
        new RegExp(`\\b${c}\\b`).test(lowerCombined),
      );
      const colorFilter = requestedColor
        ? {
            OR: [
              { title: { contains: requestedColor, mode: "insensitive" } },
              {
                Variant: {
                  some: {
                    title: { contains: requestedColor, mode: "insensitive" },
                  },
                },
              },
            ],
          }
        : null;

      const priceConditions = [];
      if (priceMin != null || priceMax != null) {
        const priceCond = {};
        if (priceMin != null) priceCond.gte = priceMin;
        if (priceMax != null) priceCond.lte = priceMax;
        priceConditions.push({ priceMin: priceCond });
      }

      const titleOr = wordForms.map((w) => ({
        title: { contains: w, mode: "insensitive" },
      }));
      const baseAnd = [
        { OR: titleOr },
        ...priceConditions,
        ...genderConditions,
      ];

      // Attribute filters, in priority order — LAST item is dropped
      // FIRST when a search returns zero results. This is the
      // generalized replacement for what used to be two separate,
      // copy-pasted relax blocks (one for orientation, one for vendor).
      // Every recurring "customer says X, X lives on Variant/vendor not
      // Product.title, so it must be a real AND filter not an OR
      // keyword" case (hand, color, brand — and whatever the next one
      // turns out to be) plugs into this one array instead of getting
      // its own bespoke fallback block. Ordering reflects how load-
      // bearing each constraint usually is to the customer: vendor
      // (brand) is dropped last/most reluctantly since customers who
      // name a brand usually mean it strictly; orientation is dropped
      // first since "left/right" is sometimes just noise in the query.
      const attributeFilters = [
        { key: "orientation", condition: orientationFilter },
        { key: "color", condition: colorFilter },
        { key: "vendor", condition: vendorConditions[0] || null },
      ].filter((f) => f.condition);

      const relaxed = {}; // key -> true once that attribute has been dropped
      let activeFilters = attributeFilters;
      let usedWhere = {
        status: "active",
        AND: [...baseAnd, ...activeFilters.map((f) => f.condition)],
      };
      let products = await prisma.product.findMany({
        where: usedWhere,
        take: Math.min(limit, 15),
        include: { Variant: { take: 25 } },
      });

      // Honest relaxation: rather than silently returning empty (forcing
      // the model to either go silent or guess from memory) or silently
      // dropping ALL constraints at once (letting irrelevant results
      // through with no signal), drop the least load-bearing remaining
      // attribute filter, retry, and repeat until something matches or
      // nothing's left to drop. Each dropped attribute is recorded in
      // `relaxed` so the model can tell the customer honestly exactly
      // which constraint didn't have a match, instead of presenting
      // relaxed results as if they satisfied everything asked for.
      while (products.length === 0 && activeFilters.length > 0) {
        const [dropped, ...rest] = activeFilters;
        relaxed[dropped.key] = true;
        activeFilters = rest;
        usedWhere = {
          status: "active",
          AND: [...baseAnd, ...activeFilters.map((f) => f.condition)],
        };
        products = await prisma.product.findMany({
          where: usedWhere,
          take: Math.min(limit, 15),
          include: { Variant: { take: 25 } },
        });
      }

      // Fall back to the broader vendor/tags-inclusive search only if
      // even fully-relaxed title matching found nothing — preserves
      // support for vague/brand-only browsing ("show me Callaway stuff")
      // without letting it dominate more specific queries. Any attribute
      // filter that's already been relaxed above must NOT be silently
      // reimposed here — it was already proven to return zero.
      if (products.length === 0) {
        const broadOr = wordForms.flatMap((w) => [
          { title: { contains: w, mode: "insensitive" } },
          { vendor: { contains: w, mode: "insensitive" } },
          { tags: { has: w } },
        ]);
        usedWhere = {
          status: "active",
          AND: [
            { OR: broadOr },
            ...priceConditions,
            ...genderConditions,
            ...activeFilters.map((f) => f.condition),
          ],
        };
        products = await prisma.product.findMany({
          where: usedWhere,
          take: Math.min(limit, 15),
          include: { Variant: { take: 25 } },
        });
      }

      // Total match count (not just what's shown) — lets the model
      // honestly offer "want to see more?" instead of guessing whether
      // more exist, or worse, implying these 5 are all there is.
      const totalCount = await prisma.product.count({ where: usedWhere });

      // When a color was requested AND actually satisfied (not
      // relaxed), trim each product's variant list down to only the
      // matching color. Without this, a product with both a "Red" and
      // a "Sky Blue" variant would still show its full variant list, and
      // the model has to correctly infer which one the customer meant —
      // exactly the kind of inference that went wrong before. If color
      // was relaxed, leave variants untouched (there's no valid color
      // match to narrow to) and let the model rely on the colorRelaxed
      // flag instead.
      const variantFilter =
        requestedColor && !relaxed.color
          ? (v) => v.title.toLowerCase().includes(requestedColor)
          : null;

      return {
        results: products.map((p) => {
          const variants = variantFilter
            ? p.Variant.filter(variantFilter)
            : p.Variant;
          return {
            productId: p.id,
            title: p.title,
            vendor: p.vendor || null,
            priceMin: p.priceMin,
            priceMax: p.priceMax,
            imageUrl: p.imageUrls?.[0] || null,
            productUrl: `https://${env.shopify.shopDomain}/products/${p.handle}`,
            variants: (variants.length ? variants : p.Variant).map((v) => ({
              variantId: v.id,
              title: v.title,
              price: v.price,
            })),
          };
        }),
        totalCount,
        moreAvailable: totalCount > products.length,
        // true = a hand-orientation filter was requested but found
        // nothing, so results were relaxed back to "any hand" — the
        // model must say so plainly rather than presenting them as a
        // match for the orientation asked for.
        orientationRelaxed: !!relaxed.orientation,
        // true = a color filter was requested but found nothing, so
        // results were relaxed back to "any color" — say so plainly,
        // never present these as matching the color asked for.
        colorRelaxed: !!relaxed.color,
        // true = a brand/vendor filter was requested but found nothing,
        // so results were relaxed back to "any brand" — the model must
        // say so plainly (and must NOT claim these results are the
        // requested brand — check the vendor field on each result
        // instead of asserting from memory).
        vendorRelaxed: !!relaxed.vendor,
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
      // Deliberately does NOT change conversation.state anymore. This
      // used to flip to AWAITING_HUMAN, which froze the AI out of the
      // conversation until either a manual reset or the next customer
      // message triggered auto-resume — in practice this kept surprising
      // customers with silence or a generic holding message mid-flow,
      // even for routine "I can't confirm real stock, flagging to the
      // team" cases that don't need the AI to stop helping. This is now
      // purely a notification: staff still see it in AuditLog for
      // follow-up, but the AI keeps handling the conversation live,
      // continuously, no matter how many times this fires.
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
