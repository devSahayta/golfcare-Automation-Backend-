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

const { computeEnvelope } = require("../pricingEngine/computeEnvelope");
const { loadPricingConfig } = require("../pricingEngine/pricingConfigLoader");
const {
  resolveVariantPricingInputs,
} = require("../pricingEngine/resolveVariantPricingInputs");
const {
  createStandingMemberDiscountCode,
  createCartDiscountCode,
} = require("../shopifyDiscounts");

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
      console.log(
        "[search_products] called with:",
        JSON.stringify({ query, category, vendor, priceMin, priceMax, limit }),
      );
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
      // condition is built further down, once lowerCombined is available.
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

      // Candidate pool size for the DB query — deliberately much bigger
      // than the requested `limit`. The old code took `limit` rows
      // directly from the DB with no ordering, so whichever rows Postgres
      // returned first silently won even if a better match existed further
      // down. Pulling a generous pool here and ranking/truncating in JS
      // below (after scoreProduct) fixes that without touching the actual
      // filter conditions at all.
      const candidatePoolSize = 500;

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
        take: candidatePoolSize,
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
          take: candidatePoolSize,
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
          take: candidatePoolSize,
          include: { Variant: { take: 25 } },
        });
      }

      // Total match count (not just what's shown) — lets the model
      // honestly offer "want to see more?" instead of guessing whether
      // more exist, or worse, implying these 5 are all there is.
      const totalCount = await prisma.product.count({ where: usedWhere });

      // Rank the candidate pool by how well each one actually matches —
      // title match weighted highest, then vendor/productType, then tags.
      // This is the fix for the live bug: without this, "JPX 923 Hot Metal
      // irons" returned "JPX 923 Forged" instead of the exact Hot Metal HL
      // product, purely because nothing ranked candidates by relevance
      // before truncating to the first few rows. Scored in JS rather than
      // in SQL since there's no full-text search index set up yet — this
      // is the same "no embedding pipeline yet" situation as the OR-based
      // matching above, just extended to also rank, not only filter.
      function scoreProduct(p) {
        const title = (p.title || "").toLowerCase();
        const vendorLower = (p.vendor || "").toLowerCase();
        const typeLower = (p.productType || "").toLowerCase();
        const tagsLower = (p.tags || []).map((t) => t.toLowerCase());
        let score = 0;
        for (const w of wordForms) {
          const wl = w.toLowerCase();
          if (title.includes(wl)) score += 3;
          if (vendorLower.includes(wl)) score += 2;
          if (typeLower.includes(wl)) score += 2;
          if (tagsLower.some((t) => t.includes(wl))) score += 1;
        }
        // Small tie-break: prefer a tighter, more specific title over a
        // longer one when the word-match score is otherwise equal.
        score -= title.split(/\s+/).length * 0.01;
        return score;
      }

      products = [...products]
        .sort((a, b) => scoreProduct(b) - scoreProduct(a))
        .slice(0, Math.min(limit, 15));

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
      // Strips descriptionHtml before returning to the model — raw HTML
      // markup the model never needs, and since this result gets resent
      // on every subsequent tool-loop iteration + every later turn in
      // the conversation, keeping it in was compounding cost for zero
      // benefit.
      if (variantId) {
        const variant = await prisma.variant.findUnique({
          where: { id: variantId },
          include: { Product: true },
        });
        if (!variant) return { error: "variant_not_found" };
        const { descriptionHtml, ...productWithoutHtml } = variant.Product;
        return { variant, product: productWithoutHtml };
      }
      if (productId) {
        const product = await prisma.product.findUnique({
          where: { id: productId },
          include: { Variant: true },
        });
        if (!product) return { error: "product_not_found" };
        const { descriptionHtml, ...productWithoutHtml } = product;
        return { product: productWithoutHtml };
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

    // ========================================================================
    // PRICING ENGINE — get_price_envelope
    //
    // Member Pricing Engine Phase 1 build spec §5. The agent calls this
    // before quoting ANY price to a member — it's the only source of
    // truth for member price / lowest allowed price / negotiation steps.
    // Deliberately strips computeEnvelope's `_full` (costPrice,
    // floorPrice, leversApplied, belowFloorAtList) before returning —
    // the agent must never see cost, margin, or why a discount exists.
    // ========================================================================
    async get_price_envelope({ lines }) {
      if (!customerId) {
        // No pricing context without a known customer — mirrors
        // get_customer_profile's own "not a customer yet" posture rather
        // than inventing a fallback.
        return { error: "no_customer_context" };
      }
      if (!lines?.length) return { error: "lines_required" };

      // Fresh, not context.customer — same reasoning as
      // get_customer_profile above: context is a turn-start snapshot and
      // can be stale if something earlier in this turn already changed
      // the customer (e.g. just enrolled). Pricing must never run on
      // stale membership data.
      const liveCustomer = await prisma.customer.findUnique({
        where: { id: customerId },
      });
      if (!liveCustomer) return { error: "customer_not_found" };

      const variantIds = lines.map((l) => l.variantId);
      const [resolvedInputs, config, activeCampaigns] = await Promise.all([
        resolveVariantPricingInputs(variantIds),
        loadPricingConfig(),
        prisma.discountCampaign.findMany({
          where: {
            isActive: true,
            startsAt: { lte: new Date() },
            endsAt: { gte: new Date() },
          },
        }),
      ]);

      // Full cart (all requested lines) — needed by the bundle lever and
      // the high-ticket cart-value check inside computeEnvelope, so every
      // line's envelope is computed against the WHOLE cart, not itself in
      // isolation.
      const cartLines = lines
        .map((l) => {
          const resolved = resolvedInputs[l.variantId];
          if (resolved?.error) return null;
          return {
            variantId: l.variantId,
            qty: l.qty || 1,
            unitListPrice: Number(resolved.variant.listPrice),
          };
        })
        .filter(Boolean);

      const results = [];
      for (const line of lines) {
        const resolved = resolvedInputs[line.variantId];
        if (resolved?.error) {
          results.push({ variantId: line.variantId, error: resolved.error });
          continue;
        }
        const envelope = computeEnvelope({
          variant: resolved.variant,
          product: resolved.product,
          customer: {
            isMember: liveCustomer.isMember,
            tier: liveCustomer.tier,
            ltvPercentile: liveCustomer.ltvPercentile,
          },
          cart: { lines: cartLines },
          activeCampaigns,
          now: new Date(),
          config,
        });
        // _full (costPrice, floorPrice, leversApplied, etc.) is
        // deliberately dropped here — this is the one enforcement point
        // that guarantees the model never receives cost/floor/lever
        // data, no matter what computeEnvelope returns internally. Do
        // not spread `envelope` as-is.
        const { _full, ...agentEnvelope } = envelope;
        results.push(agentEnvelope);
      }
      return results;
    },

    // ========================================================================
    // PRICING ENGINE — make_offer
    //
    // Required before quoting/confirming anything below member price.
    // Recomputes the envelope server-side (never trusts a cached one),
    // rejects anything below the real lowest allowed price or that skips
    // ahead in the negotiation ladder, and records what was actually
    // offered so create_checkout_link (Phase 4) can validate against it.
    // ========================================================================
    async make_offer({ variantId, price, step }) {
      if (!customerId) return { error: "no_customer_context" };
      if (price == null || step == null)
        return { error: "price_and_step_required" };

      const liveCustomer = await prisma.customer.findUnique({
        where: { id: customerId },
      });
      if (!liveCustomer) return { error: "customer_not_found" };

      const resolvedInputs = await resolveVariantPricingInputs([variantId]);
      const resolved = resolvedInputs[variantId];
      if (resolved?.error) return { error: resolved.error };

      const config = await loadPricingConfig();

      // Single-line envelope — make_offer's own params are one variant at
      // a time (matches the build spec's tool signature exactly), so the
      // bundle lever can't see the rest of the cart here. This means a
      // make_offer call checks a slightly narrower room than the
      // get_price_envelope call the agent saw moments earlier if the real
      // cart has multiple items — in practice the allowed price from
      // make_offer's recompute can only be EQUAL OR LOWER than what
      // get_price_envelope showed (never higher), so this is
      // conservative, not a hole: it can reject a price get_price_envelope
      // implied was fine, never approve one it didn't. Revisit if that
      // mismatch proves annoying in practice — passing the full cart into
      // make_offer too is the fix, not a correctness bug as implemented.
      const envelope = computeEnvelope({
        variant: resolved.variant,
        product: resolved.product,
        customer: {
          isMember: liveCustomer.isMember,
          tier: liveCustomer.tier,
          ltvPercentile: liveCustomer.ltvPercentile,
        },
        cart: {
          lines: [
            {
              variantId,
              qty: 1,
              unitListPrice: Number(resolved.variant.listPrice),
            },
          ],
        },
        activeCampaigns: await prisma.discountCampaign.findMany({
          where: {
            isActive: true,
            startsAt: { lte: new Date() },
            endsAt: { gte: new Date() },
          },
        }),
        now: new Date(),
        config,
      });

      // step 9 = owner-approved via the escalation card (Phase 5) —
      // bypasses the ladder-order check below since a human already
      // signed off on a specific price. Every other step must still
      // respect the floor.
      if (step !== 9 && Number(price) < envelope.lowestAgentPrice) {
        return {
          error: "price_below_lowest_allowed",
          lowestAgentPrice: envelope.lowestAgentPrice,
        };
      }

      const now = new Date();
      const existingActive = await prisma.offer.findFirst({
        where: {
          customerId,
          variantId,
          status: "active",
          expiresAt: { gt: now },
        },
        orderBy: { createdAt: "desc" },
      });

      // "Customer asks again within validity" — same price re-requested
      // on a still-active offer returns that same offer rather than
      // minting a new row / new discount code for an unchanged
      // negotiation.
      if (
        existingActive &&
        Number(existingActive.offeredPrice) === Number(price)
      ) {
        return {
          offerId: existingActive.id,
          price: Number(existingActive.offeredPrice),
          step: existingActive.step,
          expiresAt: existingActive.expiresAt,
        };
      }

      // Step-order guard: can't jump straight to a deeper concession than
      // the next one in line. "Next allowed" = one past whatever step was
      // last offered for this customer+variant (0 if nothing offered
      // yet). step 9 (owner-approved) always bypasses this.
      if (step !== 9) {
        const lastOffer = await prisma.offer.findFirst({
          where: { customerId, variantId },
          orderBy: { createdAt: "desc" },
        });
        const nextAllowedStep = lastOffer ? lastOffer.step + 1 : 0;
        if (step > nextAllowedStep) {
          return { error: "step_skips_ahead", nextAllowedStep };
        }
      }

      if (existingActive) {
        await prisma.offer.update({
          where: { id: existingActive.id },
          data: { status: "superseded" },
        });
      }

      const offer = await prisma.offer.create({
        data: {
          conversationId: context.conversation.id,
          customerId,
          variantId,
          listPrice: envelope.listPrice,
          offeredPrice: price,
          step,
          leversApplied: envelope._full.leversApplied, // server-side only — never returned to the caller below
          floorAtOffer: envelope._full.floorPrice,
          status: "active",
          expiresAt: new Date(
            now.getTime() + config.offer.validityHours * 60 * 60 * 1000,
          ),
        },
      });

      return {
        offerId: offer.id,
        price: Number(offer.offeredPrice),
        step: offer.step,
        expiresAt: offer.expiresAt,
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

      // Re-query live DB state rather than trusting `context.customer` /
      // `context.unansweredQuestions` as-is. Both are snapshotted ONCE at
      // the start of the turn, before any tool calls in THIS turn have
      // run. If enroll_membership already executed earlier in the same
      // reply (which it can — the model is instructed to enroll, then
      // continue straight into Part A questions in the same message),
      // the stale `context` snapshot still shows the pre-enrollment
      // world: isMember: false, unansweredQuestions: [] (since the
      // context-builder had no reason to populate Part A questions for
      // a not-yet-a-member customer at turn start). That stale "nothing
      // to ask" signal is exactly what caused the model to skip
      // onboarding and reveal the member code immediately after
      // enrolling — a real customer got the code with zero profiling
      // questions asked. Fetching fresh here makes get_customer_profile
      // trustworthy no matter when in the turn it's called.
      const liveCustomer = await prisma.customer.findUnique({
        where: { id: customerId },
      });
      if (!liveCustomer) {
        return {
          isMember: false,
          tier: null,
          unansweredQuestions: context.unansweredQuestions.map(
            (q) => q.fieldKey,
          ),
        };
      }

      const liveGolferProfile = await prisma.golferProfile.findUnique({
        where: { customerId },
      });

      let liveUnanswered = context.unansweredQuestions.map((q) => q.fieldKey);
      if (liveCustomer.isMember) {
        // Once enrolled, the authoritative "what's left" list is
        // whichever ENROLMENT_FIELD_KEYS have no OnboardingResponse row
        // yet — computed fresh, not from the turn-start snapshot.
        const answered = await prisma.onboardingResponse.findMany({
          where: { customerId, fieldKey: { in: ENROLMENT_FIELD_KEYS } },
          select: { fieldKey: true },
        });
        const answeredSet = new Set(answered.map((a) => a.fieldKey));
        liveUnanswered = ENROLMENT_FIELD_KEYS.filter(
          (k) => !answeredSet.has(k),
        );
      }

      return {
        isMember: liveCustomer.isMember,
        tier: liveCustomer.tier,
        budgetTier: liveGolferProfile?.budgetTier || null,
        handicap: liveGolferProfile?.handicap ?? null,
        preferredBrands: liveGolferProfile?.preferredBrands || [],
        unansweredQuestions: liveUnanswered,
        onboardingComplete: liveCustomer.onboardingState === "COMPLETED",
      };
    },

    // ========================================================================
    // Member Pricing Engine Phase 4. Previously built checkout links from
    // raw list price with zero discount logic — deliberately left that
    // way through Phase 3, since validating a negotiated Offer against a
    // checkout link with no real Shopify discount behind it would've been
    // a check with no teeth. Now actually prices each line correctly
    // (member price, or a negotiated Offer's price if one is active) and,
    // if any discount is owed, mints ONE fresh single-use Shopify
    // discount code for the whole cart (see shopifyDiscounts.js) rather
    // than trying to stack a per-line code — Shopify checkout only wants
    // one code applied cleanly at a time. "Calculate variant-wise, apply
    // cart-wise."
    //
    // A non-member, or a member whose items carry no discount at all
    // (e.g. pricingLocked products), gets the exact same plain list-price
    // link as before — no code minted, nothing to go wrong there.
    //
    // If Shopify's discount-code API call itself fails (network issue,
    // scope problem, etc.), this deliberately falls BACK to a plain
    // list-price link rather than failing the whole checkout — a
    // customer being unable to check out at all is worse than one who
    // has to be re-offered their discount a moment later. The failure is
    // logged to AuditLog so it doesn't go unnoticed.
    async create_checkout_link({ variantIds, quantities }) {
      if (!variantIds?.length) return { error: "variantIds_required" };

      const resolvedInputs = await resolveVariantPricingInputs(variantIds);
      for (const id of variantIds) {
        if (resolvedInputs[id]?.error) {
          return { error: "one_or_more_variants_not_found" };
        }
      }

      // Guest / no customer context yet — same as the old behaviour:
      // plain list-price link, no discount logic applies at all.
      const liveCustomer = customerId
        ? await prisma.customer.findUnique({ where: { id: customerId } })
        : null;

      const lines = variantIds.map((id, i) => ({
        variantId: id,
        qty: quantities[i] || 1,
        resolved: resolvedInputs[id],
      }));

      let config = null;
      let activeCampaigns = [];
      if (liveCustomer?.isMember) {
        [config, activeCampaigns] = await Promise.all([
          loadPricingConfig(),
          prisma.discountCampaign.findMany({
            where: {
              isActive: true,
              startsAt: { lte: new Date() },
              endsAt: { gte: new Date() },
            },
          }),
        ]);
      }

      const cartLines = lines.map((l) => ({
        variantId: l.variantId,
        qty: l.qty,
        unitListPrice: Number(l.resolved.variant.listPrice),
      }));

      let totalListInr = 0;
      let totalFinalInr = 0;
      const priced = [];

      for (const line of lines) {
        const listPrice = Number(line.resolved.variant.listPrice);
        let finalPrice = listPrice;

        if (liveCustomer?.isMember) {
          // An active, unexpired negotiated Offer for this exact
          // customer+variant wins over the plain member price — this is
          // what makes a checkout link honour whatever was actually
          // agreed in the conversation.
          const activeOffer = await prisma.offer.findFirst({
            where: {
              customerId,
              variantId: line.variantId,
              status: "active",
              expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: "desc" },
          });
          if (activeOffer) {
            finalPrice = Number(activeOffer.offeredPrice);
          } else {
            const envelope = computeEnvelope({
              variant: line.resolved.variant,
              product: line.resolved.product,
              customer: {
                isMember: liveCustomer.isMember,
                tier: liveCustomer.tier,
                ltvPercentile: liveCustomer.ltvPercentile,
              },
              cart: { lines: cartLines },
              activeCampaigns,
              now: new Date(),
              config,
            });
            // Deliberately memberPrice, not lowestAgentPrice — a
            // checkout created with no negotiation on record should
            // only ever get the plain member price, never the deepest
            // price the agent could theoretically have gone to.
            finalPrice = envelope.memberPrice;
          }
        }

        totalListInr += listPrice * line.qty;
        totalFinalInr += finalPrice * line.qty;
        priced.push({
          shopifyVariantId: line.resolved.variant.shopifyVariantId,
          qty: line.qty,
        });
      }

      const parts = priced.map((p) => `${p.shopifyVariantId}:${p.qty}`);
      // Floating-point line-by-line sums can leave a stray paisa of
      // "negative" discount (e.g. 0.00000000002) — clamp so that never
      // mints a code for a nonexistent discount.
      const totalDiscount = Math.max(
        0,
        Math.round(totalListInr - totalFinalInr),
      );

      if (totalDiscount <= 0) {
        return {
          checkoutUrl: `https://${env.shopify.shopDomain}/cart/${parts.join(",")}`,
          totalInr: totalListInr,
        };
      }

      // Short, readable, unique-enough code — human-readable in Shopify's
      // own order/discount records for later debugging, not meant to be
      // guessable or memorable to the customer (unlike the standing
      // memberCode, this is single-use and expires in hours).
      const code =
        "CO" +
        Math.random().toString(36).slice(2, 7).toUpperCase() +
        Date.now().toString(36).slice(-3).toUpperCase();
      // 48h is a first pass, not pulled from PricingConfig yet — revisit
      // if a shorter/longer window turns out to matter in practice.
      const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);

      try {
        await createCartDiscountCode({
          code,
          amountOff: totalDiscount,
          expiresAt,
        });
        return {
          checkoutUrl: `https://${env.shopify.shopDomain}/discount/${code}?redirect=/cart/${parts.join(",")}`,
          totalInr: totalFinalInr,
          savingsInr: totalDiscount,
        };
      } catch (err) {
        // Fail open to a working (if undiscounted) checkout link rather
        // than blocking the purchase entirely — but this must not go
        // unnoticed, since it means a member is about to pay more than
        // they were quoted.
        await prisma.auditLog.create({
          data: {
            actorType: "SYSTEM",
            action: "checkout_discount_code_failed",
            entityType: "Conversation",
            entityId: context.conversation.id,
            afterState: {
              customerId,
              variantIds,
              totalDiscount,
              error: err?.response?.data || err?.message || String(err),
            },
            source: "sales_agent",
          },
        });
        return {
          checkoutUrl: `https://${env.shopify.shopDomain}/cart/${parts.join(",")}`,
          totalInr: totalListInr,
          discountFailed: true,
        };
      }
    },

    async escalate_to_human({ reason, urgency, offerContext }) {
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
      //
      // offerContext (Member Pricing Engine Phase 3) — when this fires
      // mid-negotiation, carries {variantId, currentOfferId} so the
      // escalation card (Phase 5 console) can show the human tier, LTV,
      // current offer and floor without re-asking the customer anything.
      await prisma.auditLog.create({
        data: {
          actorType: "AGENT",
          action: "escalated_to_human",
          entityType: "Conversation",
          entityId: context.conversation.id,
          afterState: { reason, urgency, offerContext: offerContext || null },
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
      // and confuses the customer about which code is real. Also never
      // hand back the code on a repeat call if onboarding hasn't actually
      // finished yet — same protection as the fresh-enrollment path below,
      // so a second enroll_membership call mid-setup can't leak the code
      // early either.
      if (context.customer?.isMember) {
        if (context.customer.onboardingState === "COMPLETED") {
          return {
            enrolled: true,
            memberCode: context.customer.memberCode,
            alreadyEnrolled: true,
          };
        }
        const nextUnanswered = await prisma.onboardingResponse.findMany({
          where: { customerId, fieldKey: { in: ENROLMENT_FIELD_KEYS } },
          select: { fieldKey: true },
        });
        const answeredSet = new Set(nextUnanswered.map((a) => a.fieldKey));
        const nextKey = ENROLMENT_FIELD_KEYS.find((k) => !answeredSet.has(k));
        const nextQuestion = ENROLMENT_QUESTIONS.find(
          (q) => q.fieldKey === nextKey,
        );
        return {
          enrolled: true,
          alreadyEnrolled: true,
          doNotRevealMemberCodeYet: true,
          nextStep: {
            instruction:
              "This customer already enrolled but hasn't finished setup. Do NOT mention the member code yet — continue with the next unanswered question below.",
            fieldKey: nextQuestion?.fieldKey,
            prompt: nextQuestion?.prompt,
          },
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

      // Member Pricing Engine Phase 4 — register memberCode as a real,
      // standing Shopify discount code (10% off, store-wide, unlimited
      // use, no customer restriction — see shopifyDiscounts.js) so this
      // customer can use it themselves if they buy directly on the
      // website without the agent involved at all. Deliberately does
      // NOT block or fail enrollment if this call fails (Shopify being
      // briefly unreachable shouldn't stop someone from joining) — just
      // logged, so it doesn't silently go unnoticed. Runs exactly once,
      // right here in the genuinely-new-enrollment path, never on the
      // idempotency-guard branch above, so a customer never ends up with
      // two Shopify price rules for the same memberCode.
      try {
        await createStandingMemberDiscountCode({
          memberCode,
          percentOff: (await loadPricingConfig()).member.basePct,
        });
      } catch (err) {
        await prisma.auditLog.create({
          data: {
            actorType: "SYSTEM",
            action: "standing_member_discount_code_failed",
            entityType: "Customer",
            entityId: customerId,
            afterState: {
              memberCode,
              error: err?.response?.data || err?.message || String(err),
            },
            source: "sales_agent",
          },
        });
      }

      // Self-contained next-step instruction — do NOT rely on the model
      // remembering the STEP 3 prompt guidance from several messages
      // back, or on context.unansweredQuestions being fresh (it's
      // snapshotted at turn start and won't yet reflect this enrollment
      // — see get_customer_profile's staleness comment for the exact
      // bug this caused: a customer got their member code with zero
      // onboarding questions asked, because the model checked
      // get_customer_profile mid-turn, saw a stale empty
      // unansweredQuestions list, and concluded there was nothing left
      // to do). The first Part A question is generated fresh right
      // here, in the same return value as the enrollment success, so
      // the model has no path to "forget" it exists.
      const firstQuestion = ENROLMENT_QUESTIONS[0];

      return {
        enrolled: true,
        memberCode: updated.memberCode,
        doNotRevealMemberCodeYet: true,
        nextStep: {
          instruction:
            "Do NOT mention the member code in this reply. In THIS SAME reply, briefly explain you'll ask a few quick setup questions, then ask exactly the question below and call record_profile_answer with the exact fieldKey shown once they answer. The member code is only revealed once record_profile_answer eventually returns enrolmentCompleted: true — never before that.",
          fieldKey: firstQuestion?.fieldKey,
          prompt: firstQuestion?.prompt,
        },
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
