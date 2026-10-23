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
const { matchProductImage } = require("../productImageMatchService");
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
// Returns { variants: [{ label, bodyText, tone, headerType, headerText, headerImagePromptHint, headerImageHeadline, footerText, buttons }], recommendedIndex: number }
//
// headerImageHeadline is a deliberate, known-risk feature: it asks Flux to
// render a short line of real text (e.g. "Celebrate Diwali with Us")
// directly into the generated photo, so the image communicates what the
// campaign is for at a glance, not just a decorative product shot. Two
// things to know about this (confirmed with the business owner before
// building it, not a silent default):
//   1. Flux (and image models generally) are unreliable at rendering
//      legible text — it can come out garbled or misspelled. Staff should
//      check the preview before saving a draft, and can click "Generate
//      new image" to retry if the text came out wrong.
//   2. WhatsApp template header images containing text are more likely to
//      be rejected by Meta's review than text-free ones. This was a
//      conscious trade-off, not an oversight — if a template gets
//      rejected over this, resubmit with headerImageHeadline left out.

const CONTENT_GEN_PROMPT = `You write WhatsApp message variants for Golf Care, a golf equipment retailer in India.

Given a campaign intent, context, and any specific requests (like "add a header", "add an image", "add buttons", "add a footer"), write exactly 3 message variants.

Each variant has these fields:
- bodyText (required): starts with "Hi {{1}},", up to 900 characters after the greeting
- label (required): "Recommended", "Direct", or "Conversational"
- tone (required): one sentence describing this variant's approach
- headerType (required): "IMAGE" for a photographic golf scene image, "TEXT" if a short text header helps, otherwise "NONE"
- headerText: short header text if headerType is "TEXT" (max 60 chars, plain text, no variables, no emojis)
- headerImagePromptHint: ONLY when headerType is "IMAGE" — a specific, concrete image description that will be used VERBATIM to generate the photo. Write it the way a commercial product photographer or art director would brief a shoot, not a plain inventory list of what's in frame. Describe the SCENE only (no wording/text here — wording is handled entirely by headerImageEyebrow/headerImageHeadline/headerImageBadgeText below, which are rendered as real typography over the photo, not drawn by Flux), no logos, no people's faces. 12–30 words.
  - Think like a stylist: specify the SURFACE/BACKDROP (reclaimed wood, slate, linen, a fairway), the PROP STYLING (how items are arranged — fanned out, stacked, leaning, one item slightly forward as the hero), the LIGHT (soft directional window light, golden-hour side light, a single warm key light with soft shadow), and the LENS LOOK (shallow depth of field, slight overhead/45-degree angle, macro detail on texture) — the same vocabulary you'd see in a premium catalog or editorial product shoot, e.g. Nike/Titleist-style commercial photography, not a snapshot.
  - For a campaign about ONE specific real product (e.g. "Pro V1 golf balls back in stock"): style it like hero product photography — e.g. "a single golf ball in sharp focus on a dark slate surface, dramatic soft side-lighting, shallow depth of field, a faint reflection below it, premium minimalist product photography".
  - For a THEMED or MULTI-PRODUCT campaign (a gift box/combo of several named items, a festival/occasion offer, a seasonal bundle): name the ACTUAL items, describe how a stylist would ARRANGE them together, and weave in occasion motifs as styling props (not labels) — e.g. for a Diwali gift box of ball/glove/driver headcover/shoe/cap: "a golf ball, glove, driver headcover, shoe, and cap styled as a flat-lay gift arrangement on dark wood, a few brass diyas and loose marigold petals placed as styling accents, warm directional golden-hour light, shallow depth of field, premium editorial product photography" — specific products AND deliberate styling, not a generic inventory phrase like "golf equipment collection" or "assorted golf gear".
  - CRITICAL — occasion props must match the ACTUAL occasion named in the campaign, never a default. Diyas (oil lamps) and marigold petals are specific to Diwali and ONLY Diwali — never use them for Christmas, New Year, a generic "festive"/"holiday" campaign, or any occasion that isn't explicitly Diwali. Pick props from the real occasion instead:
    - Diwali: brass diyas with small warm flames, marigold petals, fairy lights
    - Christmas: pine or fir sprigs, small red baubles/ornaments, warm string lights, a sprig of holly, pinecones
    - New Year: gold/silver confetti, a single sparkler, a champagne flute (no alcohol branding visible)
    - Republic Day / Independence Day: a small tricolour ribbon or bunting, no flag imagery that could look like misuse of a national symbol
    - Generic sale/offer/restock with no named occasion: no themed props at all — just clean premium styling (wood/slate/linen surface, controlled light), nothing invented
    If you are not certain which occasion a campaign refers to, default to NO occasion props rather than guessing — plain premium styling is always safe; the wrong festival's motifs are not.
  - Avoid plain, flat description ("a picture of X and Y on a table"). Every hint should read like a photography/styling brief with a clear surface, light, and composition choice.
  - BRAND PALETTE — Golf Care's identity is deep forest green, white, and warm gold. Weave this into the scene naturally through surface color, accent props, or background tone — e.g. "a deep forest-green felt surface", "a white marble surface with gold-toned accessories", "a rich dark-green backdrop with soft warm gold side-lighting". Do not force it if the occasion already has a stronger color story (Christmas red/green is fine and naturally matches), but default to green-toned surfaces and warm gold light whenever no other palette is dictated by the occasion.
  - Do NOT describe any text/wording here — headerImagePromptHint is the SCENE only.
- headerImageEyebrow: OPTIONAL, only when headerType is "IMAGE" — a short kicker/label line (max 4 words, ~28 characters) rendered in small letter-spaced caps ABOVE the headline. Leave null if the headline already says it all.
- headerImageHeadline: OPTIONAL, only when headerType is "IMAGE" — the big, bold statement line (max 6 words, ~40 characters) rendered by the AI directly into the generated image as part of the same shot (AI_SCENE path only — ignored entirely for RAW_PHOTO, which has no AI step to draw it). Use this whenever the image alone wouldn't make the occasion/purpose obvious at a glance. Leave it null only for a simple single-product restock where the product itself is self-explanatory. Keep it punchy — this is a headline, not a sentence. Never include a price, phone number, or anything time-sensitive.
- headerImageBadgeText: OPTIONAL, only when headerType is "IMAGE" — a very short tag/pill (max 3 words, ~16 characters) rendered by the AI as a small rounded badge below the headline (AI_SCENE path only, same as headerImageHeadline), the way a product ad has a "FLASH SALE" or "NEW" sticker. This is what makes the image feel like a real promotional creative instead of a plain product photo — use it for PROMOTION/EVENT campaigns where there's a genuine hook (an offer, a limited window, a bundle). Leave null for a plain restock with no particular angle. Never put a price or a countdown/urgency claim you can't actually back ("today only" etc.) — keep it to what's true.

VARY THE WORDING PATTERN EVERY TIME — do not settle into one template. A real reviewer of this prompt noticed back-to-back campaigns all coming out as "[Occasion] at Golf Care" / "[Product A] & [Product B] Combo" / "Festive Offer" — technically correct but repetitive and visibly templated once staff see more than one. Pick a DIFFERENT structural approach each time, for example (mix and match, don't always reach for the first one):
  - Occasion-led: eyebrow names the occasion, headline is a benefit or command — "Diwali at Golf Care" / "Light Up Your Game" / "Festive Offer"
  - Product-led: eyebrow is a category/status tag, headline names the product plainly — "New Arrival" / "Pro V1 Dozen Pack" / "In Stock Now"
  - Benefit-led: headline leads with what the customer gets, no eyebrow needed — "Two Legends, One Price" / (badge) "Limited Stock"
  - Question or direct-address: "Ready for Round One?" / "Your Winter Golf Kit" — skip the generic "X Combo" naming entirely
  - Plain and confident, no badge at all: sometimes the strongest choice is just a clean headline with nothing else — not every image needs all three fields filled
  Also vary WORD CHOICE for the same concept across campaigns — don't always reach for "Festive Offer" for a badge or "Combo" for a headline; use whatever genuinely fits that specific campaign's tone and offer (e.g. "Gift Ready", "Grab Yours", "Stock Up", "Holiday Pick", "Just Landed", "Members First" are all valid alternatives depending on context). Read the campaign's own context/intent and let IT drive the wording, rather than defaulting to the same formula you used last time.
- footerText: short footer line if requested or appropriate (max 60 chars, e.g. "Reply STOP to opt out")
- buttons: array of up to 2 quick-reply button objects if requested, e.g. [{"type":"QUICK_REPLY","text":"Count me in"},{"type":"QUICK_REPLY","text":"Not interested"}]

Staff can edit headerImageEyebrow/headerImageHeadline/headerImageBadgeText themselves in the preview after the image is generated, without regenerating the photo (it just re-draws the text layer, so it's instant and free) — so write your best, specific wording rather than something generic or null "to be safe"; it's easy for staff to tweak.

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

Meta image rules (the AI image should stay as safe as possible for Meta review):
- headerImagePromptHint must describe a CLEAN, PHOTOREALISTIC GOLF-RELATED SCENE — an outdoor
  course scene for single-product or general campaigns, or a tabletop/still-life arrangement of
  the actual named products for multi-product/gift/combo campaigns. Either is fine as long as it's
  real photography, not an illustration or graphic.
- No logos, no branding, no watermarks
- No price tags, no banners, no countdown/urgency text
- Natural lighting, photorealistic style
- The ONLY text allowed anywhere in the image is the short wording in headerImageHeadline, if set —
  everything else about the scene stays text-free (no extra signage, no readable labels on products).

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
      "headerImagePromptHint": "a trophy and golf ball on a championship fairway at golden hour, dramatic warm side light, shallow depth of field, premium editorial sports photography",
      "headerImageEyebrow": "Golf Care Presents",
      "headerImageHeadline": "1st Anniversary Tournament",
      "headerImageBadgeText": "RSVP Now",
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
      "headerImageEyebrow": null,
      "headerImageHeadline": null,
      "headerImageBadgeText": null,
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
      "headerImageEyebrow": null,
      "headerImageHeadline": null,
      "headerImageBadgeText": null,
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
  headerImageProductTitles = null,
  imageMode = null,
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

  // When the agent has already confirmed real catalog photos for specific
  // products (via check_product_photo, before this was ever called) AND the
  // staff member chose the AI_SCENE path (STEP 2.6) rather than RAW_PHOTO,
  // those exact photos are handed to FLUX.2 Pro as REFERENCE IMAGES — Flux
  // regenerates the whole frame in one pass, product included, rather than
  // code pasting an unmodified cutout onto a separately-generated backdrop.
  // The exact product list itself is NOT something Haiku invents or echoes
  // — it's attached to the variant afterward, verbatim, from what was
  // already confirmed; this directive just tells Haiku how to write the
  // scene around it.
  let productDirective = "";
  if (
    Array.isArray(headerImageProductTitles) &&
    headerImageProductTitles.length > 0
  ) {
    productDirective = `\nREAL PRODUCT PHOTO(S) PROVIDED AS AI REFERENCE IMAGES FOR: ${headerImageProductTitles.join(", ")}. FLUX.2 Pro will regenerate the whole scene using these as reference, including the product itself — not paste an unmodified cutout. You MAY describe the product naturally as part of the scene (how it's arranged, positioned, lit relative to any props) — there's no hard-edged cutout to protect, so ordinary styling language (soft glow, props near the product, etc.) is fine, unlike a flat paste. Do NOT invent a different product than what's named, and do NOT describe any change to the product's own appearance (no re-coloring, no redesigning, no adding/removing markings, no different packaging) — the reference image's whole purpose is for Flux to reproduce that real product faithfully, and your scene description should support that, not fight it.`;
  }

  // Forced wording-pattern variety for headerImageEyebrow/Headline/BadgeText.
  //
  // Earlier this just TOLD the model to vary its wording between campaigns.
  // That didn't hold up — confirmed from two real generated images sent
  // back: a Christmas and a Diwali campaign both still came out as
  // "[Occasion] AT GOLF CARE" / "[Product A] & [Product B] COMBO" / a
  // generic offer-word badge, just with different product names slotted
  // in. That phrasing is clearly the model's strong default for this kind
  // of content — a soft instruction to "mix it up" doesn't reliably beat a
  // habit that strong. So instead of asking, this PICKS one structural
  // pattern at random per generation call and hands it over as a required
  // structure for this specific campaign, with the two overused phrasings
  // explicitly banned. Randomizing in code guarantees actual variety across
  // calls — the model no longer gets to default to its favorite shape,
  // because a different one is assigned on each request.
  const WORDING_PATTERNS = [
    'Eyebrow: just the occasion/theme name on its own — NOT "[Occasion] at Golf Care". Headline: a short benefit or action statement (what the customer gets or should do), NOT a "[Product A] & [Product B]" list and NOT the word "Combo". Badge: a specific value/urgency word — NOT "Festive Offer".',
    'Eyebrow: a plain status word only ("New In", "Back in Stock", "Just Landed", "In Stock Now") — no occasion name in the eyebrow at all, even if the campaign is about a festival. Headline: the product name(s) written plainly, like a shelf tag. Badge: availability/stock info, not a generic offer word.',
    'Leave the eyebrow null entirely — no eyebrow line. Headline: lead with the customer benefit or outcome in a punchy phrase, NOT a product-name list joined with "&", and NOT the word "Combo". Badge: a short value or urgency tag.',
    'Headline: phrase it as a short question or a direct command to the reader, not a list of product names joined with "&". Eyebrow: optional — if used, the occasion name alone, never "at Golf Care". Badge: optional, a short call-to-action word.',
    "Use ONLY the headline — leave both eyebrow and badge null for this one. The headline alone should say what this is, confidently, in a few words, without needing support text around it.",
    'Headline: state the deal or value directly (how many, bundled, or saved) rather than naming the products — written like a price-tag headline, not "[Product A] & [Product B] Combo". Eyebrow: the occasion name alone if used, never "at Golf Care". Badge: a short action word.',
  ];
  const assignedPattern =
    WORDING_PATTERNS[Math.floor(Math.random() * WORDING_PATTERNS.length)];
  const wordingPatternDirective = `\nON-IMAGE WORDING STRUCTURE FOR THIS CAMPAIGN (headerImageEyebrow / headerImageHeadline / headerImageBadgeText — follow this shape, don't default to a generic template): ${assignedPattern} Whatever specific words you choose, they must genuinely fit THIS campaign's occasion/products/offer — don't force in a word from this instruction that doesn't make sense here.`;

  const userMessage = `Campaign name: ${campaignName}
Intent: ${intent}
Context: ${context || "No additional context provided."}${headerDirective}${productDirective}${wordingPatternDirective}

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
     * check_product_photo — look up whether a named product already has a
     * real photo in the catalog, BEFORE suggest_campaign_content runs.
     *
     * This is Path A's "ask before you leap" check for the agent itself.
     * Without it, the agent would call suggest_campaign_content with an
     * IMAGE header, the frontend would try to resolve a real product photo
     * on its own, fail silently, and fall back to generating an AI image —
     * and the staff member would never be told the named product wasn't
     * actually found. This tool lets the agent find that out up front and
     * say so directly, e.g. "I couldn't find 'Callaway bags' as a specific
     * product in the catalog — want me to generate a themed image instead,
     * or did you mean a different product?"
     *
     * Uses the SAME matching function as the REST endpoint the widget
     * calls (productImageMatchService.matchProductImage), so the agent's
     * upfront answer and the widget's later resolution can never disagree.
     *
     * Read-only — never fetches or generates anything, just reports what
     * Path A would find.
     */
    async check_product_photo({ query }) {
      if (!query || !query.trim()) {
        return {
          success: false,
          error:
            "query is required (the product name or campaign subject to check)",
        };
      }
      const result = await matchProductImage(query);

      if (!result.matched) {
        return {
          found: false,
          query,
          note: `No real product in the catalog matched "${query}" closely enough. Tell the staff member this specific product wasn't found before falling back to an AI-generated image — ask them to confirm/clarify the product name, or explicitly approve a generated image instead.`,
        };
      }

      if (result.ambiguous) {
        return {
          found: true,
          ambiguous: true,
          query,
          candidates: result.candidates.map((c) => ({
            title: c.title,
            productType: c.productType,
          })),
          note: `Multiple products matched "${query}" equally well. Ask the staff member which one they meant before proceeding.`,
        };
      }

      return {
        found: true,
        ambiguous: false,
        query,
        product: {
          title: result.product.title,
          productType: result.product.productType,
          hasPhoto: result.product.imageUrls.length > 0,
        },
        note: `Found a real catalog photo for "${result.product.title}". The widget will show this real photo for approval — no AI generation needed.`,
      };
    },

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
     *   headerImageHeadline: string | null (optional short wording rendered directly in the IMAGE)
     *   headerImageProductTitles: string[] | null (exact catalog titles to composite in as
     *     real product photos — attached here in code from this tool's own input, never
     *     authored by the content model; see the suggest_campaign_content handler below)
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
      headerImageProductTitles = null,
      imageMode = null,
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
        headerImageProductTitles,
        imageMode,
      });

      // headerImageProductTitles (and imageMode alongside it) are attached
      // here, in code, rather than left for Haiku to echo back in its JSON
      // — these are exact catalog titles and an explicit staff choice the
      // agent already confirmed via check_product_photo / STEP 2.6, and
      // letting an LLM re-type/re-decide either one a second time risks a
      // subtly different (and therefore unmatched) string, or a decision
      // that was never actually the staff member's. Only IMAGE-header
      // variants get either field; a TEXT/NONE variant has no image to
      // composite products into or choose a presentation for.
      const hasRealPhoto =
        Array.isArray(headerImageProductTitles) &&
        headerImageProductTitles.length > 0;
      const variants = Array.isArray(generated.variants)
        ? generated.variants.map((v) =>
            v.headerType === "IMAGE" && hasRealPhoto
              ? {
                  ...v,
                  headerImageProductTitles,
                  // Default to AI_SCENE only as a safety net against a
                  // malformed call that skipped STEP 2.6 entirely — the
                  // system prompt requires the agent to have actually
                  // asked the staff member first.
                  imageMode:
                    imageMode === "RAW_PHOTO" ? "RAW_PHOTO" : "AI_SCENE",
                }
              : { ...v, headerImageProductTitles: null, imageMode: null },
          )
        : generated.variants;

      return {
        success: true,
        campaignName,
        audienceRules,
        audienceSize,
        intent,
        variants,
        // variants: { label, tone, bodyText, headerType, headerText, headerImagePromptHint, headerImageHeadline, headerImageProductTitles, footerText, buttons }
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
