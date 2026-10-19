// src/services/imageGenerationService.js
//
// Generates WhatsApp-template-compliant header images using Flux 1.1 Pro
// via the Replicate API.
//
// Meta image requirements for WhatsApp template headers:
//   - Aspect ratio: 1:1 square
//   - Minimum size: 500×500px (we use 1024×1024)
//   - No logos or branding, no watermarks
//   - No promotional graphics (price tags, countdown/urgency banners)
//   - Clean photographic / naturalistic scenes
//   - File format: JPEG or PNG
//
// Text in the image (`headline`/`eyebrow`/`badgeText` params):
//   Flux is NEVER asked to render text into the pixels — every prompt stays
//   text-free. This used to be an opt-in business decision (an earlier
//   version of this file asked Flux to draw the headline directly into the
//   scene when one was passed), but that was confirmed as the actual cause
//   of a real production complaint: a generated image's headline ran off
//   both edges of the frame, same unreliable-text-rendering problem the old
//   comment here already warned about, just finally hit in practice. Any
//   headline/eyebrow/badge text is instead rendered AFTER generation with
//   real typography via imageCompositingService.composeImage — the exact
//   same reliable SVG-based system (layout variety, auto-sizing/wrapping,
//   occasion decoration) used by the real-product compositing path. There's
//   no separate "text in image" mode left to choose between; this is now
//   the only path, for both the composited and non-composited cases.
//
// Model: black-forest-labs/flux-1.1-pro
//   Cost: ~$0.004/image  |  Output: 1024×1024 JPEG URL  |  Latency: 5–10s
//
// Usage:
//   const { generateCampaignImage } = require('./imageGenerationService');
//   const { imageUrl } = await generateCampaignImage({ campaignName, intent, context, headline });

const Replicate = require("replicate");
const axios = require("axios");
const sharp = require("sharp");
const { env } = require("../config/env");
const {
  removeWhiteBackground,
  composeImage,
} = require("./imageCompositingService");
const { uploadGeneratedImage } = require("./supabaseStorageService");

// ── Replicate client ──────────────────────────────────────────────────────────

function getReplicateClient() {
  if (!env.replicateApiToken) {
    throw new Error(
      "REPLICATE_API_TOKEN is not set. Add it to your .env to enable AI image generation.",
    );
  }
  return new Replicate({ auth: env.replicateApiToken });
}

// ── Meta-safe prompt builder ──────────────────────────────────────────────────
//
// Rules baked into every prompt:
//   1. Photorealistic outdoor golf scene — no cartoon/illustration styles
//   2. NO text, NO words, NO signage visible anywhere
//   3. NO logos, NO brand names, NO watermarks
//   4. NO price tags, NO promotional overlays
//   5. Natural lighting, clean composition — wide aspect handled by square crop
//
// We derive a contextual golf scene from the campaign details so each campaign
// gets a relevant (not generic) image while staying Meta-safe.

// Appended to every prompt — both the content model's own styled hint (the
// common case) and the SCENE_MAP fallback scenes (used only when no real
// hint was supplied). The styling language here ("editorial", "premium
// commercial photography") pushes the fallback scenes toward the same
// catalog/magazine-shoot look the hint-writing instructions now ask for,
// so a campaign that happens to skip the hint still looks art-directed
// rather than like a plain snapshot.
const SAFE_SUFFIX = [
  "premium commercial product photography",
  "editorial catalog styling",
  "photorealistic photography",
  "professional DSLR camera",
  "shallow depth of field",
  "natural daylight",
  "no text",
  "no words",
  "no logos",
  "no signs",
  "no watermarks",
  "no price tags",
  "no promotional overlays",
  "clean composition",
  "1:1 square crop",
].join(", ");

// Used instead of SAFE_SUFFIX only when a `headline` was explicitly
// requested — identical except it drops "no text"/"no words"/"no signs"
// (the whole point here is to allow exactly one deliberate piece of text)
// while still banning logos, watermarks, price tags and promotional
// banners/overlays, which stay off-limits regardless.
const SAFE_SUFFIX_WITH_HEADLINE = [
  "premium commercial product photography",
  "editorial catalog styling",
  "photorealistic photography",
  "professional DSLR camera",
  "shallow depth of field",
  "natural daylight",
  "no logos",
  "no watermarks",
  "no price tags",
  "no promotional overlays",
  "no countdown or urgency banners",
  "clean composition",
  "1:1 square crop",
].join(", ");

// Strips characters that would break out of the quoted phrase we embed the
// headline in, and collapses whitespace. Keeps this to a defensive sanitize
// only — the actual "keep it short, no prices, no phone numbers" guidance
// lives in the content-generation prompt that writes the headline.
function sanitizeHeadline(headline) {
  return (headline || "")
    .replace(/["'`\n\r]/g, "")
    .trim()
    .slice(0, 60);
}

// Golf scene library — mapped by campaign intent keywords
const SCENE_MAP = [
  {
    keywords: ["tournament", "competition", "event", "championship", "contest"],
    scene:
      "a well-maintained championship golf course at golden hour, lush green fairways stretching into the distance, manicured bunkers, a lone golfer mid-swing silhouetted against a warm sunset sky",
  },
  {
    keywords: ["driver", "iron", "club", "equipment", "gear", "set"],
    scene:
      "premium golf clubs arranged elegantly on fresh green grass with morning dew, shallow depth of field, soft bokeh background of a golf course fairway",
  },
  {
    // "range" alone was removed — it's ambiguous ("driving range" vs. a
    // perfectly ordinary phrase like "the full range of products"), and
    // the latter wrongly triggered this golf-ball scene for an unrelated
    // bags campaign whose body text happened to say "full range available".
    keywords: ["ball", "balls", "driving range", "golf range"],
    scene:
      "crisp white golf balls arranged on a perfectly manicured green next to a flagstick, shallow depth of field, lush fairway background",
  },
  {
    keywords: ["bag", "bags", "kit bag", "stand bag", "cart bag", "travel bag"],
    scene:
      "a premium golf bag leaning against a wooden bench beside a manicured fairway, soft morning light, clubs visible in the bag, shallow depth of field",
  },
  {
    keywords: ["glove", "gloves"],
    scene:
      "a close-up of a premium golf glove resting on fresh green grass beside a golf ball, soft natural light, shallow depth of field",
  },
  {
    keywords: ["shoe", "shoes", "spikeless", "spiked"],
    scene:
      "a pair of premium golf shoes on a manicured fairway, morning dew on the grass, soft natural light, shallow depth of field",
  },
  {
    keywords: ["cap", "hat", "visor", "apparel", "polo", "shirt", "jacket"],
    scene:
      "neatly folded premium golf apparel on a wooden bench beside a putting green, soft natural light, shallow depth of field",
  },
  {
    keywords: ["lesson", "coaching", "training", "practice", "improve"],
    scene:
      "a golfer practicing their swing at a professional driving range, early morning light, green practice mats, rows of stalls in soft focus behind them",
  },
  {
    keywords: ["member", "membership", "vip", "exclusive", "loyalty"],
    scene:
      "an elegant golf clubhouse entrance with manicured hedges and a pristine driveway, warm late-afternoon sunlight casting long shadows across a well-kept putting green",
  },
  {
    keywords: ["offer", "sale", "discount", "deal", "promo"],
    scene:
      "a wide aerial view of a stunning golf course at sunrise, mist rising from the fairways, vibrant greens and golden light creating a serene atmosphere",
  },
  {
    keywords: ["gift", "present", "gifting"],
    scene:
      "a premium golf glove, a gleaming golf ball, and a quality golf tee arranged neatly on a wooden surface with soft natural light from the side",
  },
  {
    keywords: ["monsoon", "rain", "weather", "season"],
    scene:
      "a golf course after light rain, droplets on the grass sparkling in the sun, fresh green color, calm overcast sky with hints of blue",
  },
  {
    keywords: ["summer", "heat", "hot"],
    scene:
      "a vibrant golf course under bright blue summer sky, golfers in the distance, palm trees lining the fairway, golden sunlight",
  },
  {
    keywords: ["winter", "morning", "early"],
    scene:
      "a peaceful golf course at early morning with light mist hovering over the fairway, gentle sunrise hues in pale gold and soft pink on the horizon",
  },
];

const DEFAULT_SCENE =
  "a breathtaking golf course fairway at golden hour, lush green grass glowing in warm sunlight, a distant clubhouse visible through a row of mature trees, serene and inviting atmosphere";

function wordCount(text) {
  return (text || "").trim().split(/\s+/).filter(Boolean).length;
}

// True when a backdrop hint ALREADY describes occasion decoration (diyas,
// marigolds, fairy lights, snow, ribbons, etc.) — meaning Flux is being
// asked to draw that decoration into the scene itself. Used to skip
// composeImage's own code-level decoration layer (see its skipDecoration
// param) so the two don't stack. The content-gen prompt (insightsAgentTools
// .js's CONTENT_GEN_PROMPT) writes increasingly specific, occasion-aware
// backdropHint text, so this needs checking per-campaign rather than
// assumed either way.
const THEMED_PROP_PATTERN =
  /\bdiya|diyas|marigold|rangoli|fairy light|string light|festive light|lantern|snow(flake)?|christmas tree|tinsel|ribbon|confetti|firework|tricolor|tricolour/i;
function hintAlreadyThemed(text) {
  return THEMED_PROP_PATTERN.test(text || "");
}

function buildImagePrompt(campaignName, intent, context, headline) {
  // `intent` here is usually the content model's own headerImagePromptHint
  // (e.g. "golf gift box with ball, glove, driver, shoe and cap, diwali
  // diyas softly blurred in background, warm golden light") — written by
  // Haiku with full knowledge of the specific campaign, including whether
  // it's about one product, several, or a themed occasion. It is NOT a bare
  // keyword like "EVENT" or "PROMOTION" in that case.
  //
  // The previous version threw that specific description away and instead
  // keyword-matched it against a small fixed library of ~14 canned scenes.
  // That's how a 5-item Diwali gift box campaign — whose hint happened to
  // contain the word "equipment" — ended up rendering as generic golf clubs
  // on grass: "equipment" was a trigger keyword for an unrelated, earlier
  // entry in the list, and the match won before the more fitting "gift"
  // entry (further down the array) was ever checked. This is the exact
  // same class of bug as the earlier "range" collision — a generic word in
  // free text winning a keyword match it has no business winning — just
  // with a different trigger word. Keyword-matching free text against a
  // short canned list will always be vulnerable to this.
  //
  // Fix: when a real, descriptive hint is present (several words — not a
  // bare intent enum), use it VERBATIM as the scene. It's already specific,
  // already Meta-safe (the content-gen prompt instructs no text/logos/faces),
  // and already reflects multi-product/thematic campaigns correctly — no
  // keyword matching needed or wanted.
  //
  // Only fall back to the SCENE_MAP keyword library when there's no usable
  // hint at all — e.g. a bare intent enum like "EVENT" with no
  // headerImagePromptHint, which still needs *some* reasonable scene picked.
  const hint = (intent || "").trim();
  const cleanHeadline = sanitizeHeadline(headline);

  // Headline instruction: placed as its own clause so the image generator
  // treats it as a deliberate typographic element of the scene (like text
  // printed on a gift tag or card within the composition) rather than
  // something to awkwardly stencil over the photo. Kept separate from the
  // scene description itself — headerImagePromptHint never describes
  // wording, only the scene; this is the one place text enters the prompt.
  const headlineClause = cleanHeadline
    ? `, with the words "${cleanHeadline}" rendered in clean, bold, elegant typography integrated naturally into the scene (e.g. printed on a gift tag, card, or banner within the composition), legible and well-kerned, professional poster-quality lettering`
    : "";
  const suffix = cleanHeadline ? SAFE_SUFFIX_WITH_HEADLINE : SAFE_SUFFIX;

  if (wordCount(hint) >= 4) {
    return `${hint}${headlineClause}, ${suffix}`;
  }

  const searchText = `${campaignName} ${intent}`.toLowerCase();

  let chosenScene = DEFAULT_SCENE;
  for (const entry of SCENE_MAP) {
    if (entry.keywords.some((kw) => searchText.includes(kw))) {
      chosenScene = entry.scene;
      break;
    }
  }

  // Final prompt: scene description + optional headline clause + Meta-safe constraints
  return `${chosenScene}${headlineClause}, ${suffix}`;
}

// ── Replicate output normaliser ──────────────────────────────────────────────
//
// Replicate SDK v0.25+ returns a FileOutput/ReadableStream object for image models.
// Calling .url() on it returns the CDN URL string without reading the stream body.
// This helper handles every known output shape so the rest of the code just gets
// a plain https:// string back.
//
async function extractReplicateUrl(output) {
  // Unwrap single-item arrays first
  if (Array.isArray(output)) {
    output = output[0];
  }

  // Plain string — oldest SDK behaviour
  if (typeof output === "string") {
    return output;
  }

  // FileOutput / ReadableStream with .url() — SDK >= 0.25
  // .url() is synchronous on Replicate's FileOutput; it never reads the stream body.
  if (output && typeof output.url === "function") {
    const result = output.url();
    // url() may return a URL object; coerce to string
    return result ? result.toString() : null;
  }

  // URL object (edge case)
  if (output && output instanceof URL) {
    return output.toString();
  }

  // Last resort: toString() if it produces something useful
  if (output && output.toString && output.toString() !== "[object Object]") {
    const s = output.toString();
    if (s.startsWith("http")) return s;
  }

  return null;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * generateCampaignImage
 *
 * Generates a Meta-compliant 1024×1024 golf scene image using Flux 1.1 Pro,
 * then — if any of headline/eyebrow/badgeText were passed — overlays that
 * text with real typography via composeImage, the same reliable SVG system
 * the real-product compositing path uses. Flux itself is always asked for a
 * text-free scene; see the file header comment for why.
 *
 * @param {object} params
 * @param {string} params.campaignName  - Campaign name (used for scene selection)
 * @param {string} params.intent        - Campaign intent (e.g. "golf tournament announcement")
 * @param {string} [params.context]     - Extra context (venue, date, etc.)
 * @param {string} [params.headline]    - optional big statement line, rendered
 *   with real typography after generation (not asked of Flux)
 * @param {string} [params.eyebrow]     - optional small kicker line above the headline
 * @param {string} [params.badgeText]   - optional short pill/tag below the headline
 * @returns {Promise<{ imageUrl: string, prompt: string }>}
 */
async function generateCampaignImage({
  campaignName,
  intent,
  context = "",
  headline = null,
  eyebrow = null,
  badgeText = null,
}) {
  const replicate = getReplicateClient();
  // headline is NOT passed to buildImagePrompt — Flux always generates a
  // text-free scene now; see the file header comment and generateCampaignImage's
  // own doc comment above for why text rendering moved to composeImage.
  const prompt = buildImagePrompt(campaignName, intent, context, null);

  console.log(
    `[imageGenerationService] Generating image for campaign "${campaignName}"`,
  );
  console.log(`[imageGenerationService] Prompt: ${prompt}`);

  const startTime = Date.now();

  // Replicate returns an array; index 0 is the image URL (a temporary CDN URL
  // valid for ~1 hour — we upload it to Meta via uploadMediaFromUrl immediately
  // after generation, so the short TTL is fine).
  const output = await replicate.run("black-forest-labs/flux-1.1-pro", {
    input: {
      prompt,
      width: 1024,
      height: 1024,
      // Safety / quality settings
      output_format: "jpg", // JPEG — smaller file, faster upload
      output_quality: 90, // High quality, still well under WhatsApp's limits
      safety_tolerance: 2, // Strict — blocks any borderline content
      prompt_upsampling: false, // Keep prompt literal; don't let model embellish
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Replicate SDK output shapes vary by version and model:
  //   - string: plain URL (older SDK)
  //   - FileOutput object: has .url() method (SDK >= 0.25)
  //   - ReadableStream: newer SDK streams the file bytes — call .url() which returns the CDN URL
  //   - Array: single-item array of any of the above
  //
  // The log "ReadableStream { locked: false, state: 'readable' }" means the SDK returned
  // a ReadableStream. On Replicate's FileOutput, .url() returns the CDN URL string directly
  // without consuming the stream body. We always call .url() when available.
  let fluxImageUrl = await extractReplicateUrl(output);

  if (
    !fluxImageUrl ||
    typeof fluxImageUrl !== "string" ||
    !fluxImageUrl.startsWith("http")
  ) {
    console.error(
      `[imageGenerationService] Unexpected output type: ${typeof output}`,
      output,
    );
    throw new Error(
      `[imageGenerationService] Replicate returned unexpected output: ${JSON.stringify(output)}`,
    );
  }

  console.log(
    `[imageGenerationService] Scene generated in ${elapsed}s: ${fluxImageUrl}`,
  );

  // Overlay headline/eyebrow/badgeText (if any) with real typography via the
  // same reliable system the real-product compositing path uses. productCutouts
  // is empty here — there's no separately-sourced real photo to paste in, the
  // "product" (if any) is whatever Flux drew into the scene itself. When none
  // of the three text fields are set, composeImage's text block is a no-op and
  // this just re-encodes the scene — still correct, just a harmless extra step.
  const sceneBuffer = await fetchImageBuffer(fluxImageUrl);
  const finalBuffer = await composeImage({
    backdropBuffer: sceneBuffer,
    productCutouts: [],
    headline,
    eyebrow,
    badgeText,
    // See hintAlreadyThemed's own comment — `intent` here is the scene hint
    // Flux was prompted with, so if IT already asked for occasion props,
    // don't also stack composeImage's code-level decoration on top.
    skipDecoration: hintAlreadyThemed(intent),
  });

  // Uploaded to our own storage rather than returning Replicate's URL
  // directly — Replicate's CDN link is temporary (~1hr TTL) and, now that
  // we've composited onto it, the bytes it points to aren't even the final
  // image anymore. uploadGeneratedImage is the same helper the real-product
  // compositing path already uses for this.
  const fileName = `${(campaignName || "campaign").replace(/\s+/g, "_").slice(0, 40)}_${Date.now()}_scene.jpg`;
  const imageUrl = await uploadGeneratedImage(finalBuffer, fileName);

  console.log(
    `[imageGenerationService] Final image ready (text rendered via SVG overlay, not Flux): ${imageUrl}`,
  );

  return { imageUrl, prompt };
}

async function fetchImageBuffer(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
  });
  return Buffer.from(res.data);
}

/**
 * generateCompositeCampaignImage
 *
 * The "use our real products" path: generates an AI backdrop (no products
 * described in the prompt — Flux never draws the products), fetches each
 * named product's REAL catalog photo, cuts its background out, and
 * composites the real cutouts + an optional real-font headline onto the
 * backdrop. See imageCompositingService.js for why this is deliberately
 * compositing, not image-to-image: diffusion-based image editing would
 * still redraw the product pixels and risk distorting logos/branding,
 * which defeats the whole point of "the product has to be ours".
 *
 * @param {object} params
 * @param {string} params.campaignName        - used for the backdrop scene
 * @param {string} [params.backdropHint]       - styling hint for the backdrop
 *   ONLY (surface, props, lighting) — must NOT describe products; those are
 *   pasted in separately. See insightsAgentTools.js CONTENT_GEN_PROMPT.
 * @param {string} [params.headline]           - optional big statement line, rendered
 *   with real typography during compositing (not asked of Flux)
 * @param {string} [params.eyebrow]            - optional small kicker line above the headline
 * @param {string} [params.badgeText]          - optional short pill/tag below the headline
 * @param {{title:string, imageUrl:string}[]} params.productPhotos - the
 *   real catalog photos to composite in (from productImageMatchService's
 *   getProductPhotosByTitles — already-confirmed exact titles, no fuzzy
 *   matching happens here)
 * @returns {Promise<{
 *   imageUrl: string,
 *   backdropUrl: string,
 *   prompt: string,
 *   matchedProductTitles: string[],
 *   unmatchedProductTitles: string[],
 * }>}
 */
async function generateCompositeCampaignImage({
  campaignName,
  backdropHint = "",
  headline = null,
  eyebrow = null,
  badgeText = null,
  productPhotos = [],
}) {
  const replicate = getReplicateClient();

  // Backdrop-only prompt — reuses buildImagePrompt with headline=null so it
  // always comes out text-free (the headline is composited with real fonts
  // below, not left to Flux) and never references specific products (the
  // backdropHint passed in from the agent is instructed to describe only
  // the surface/props/lighting, never the products themselves).
  // The backdrop here is a real cutout's background, not a self-contained
  // photo — a busy/glowing backdrop right under a hard-edged pasted product
  // makes the paste-in obvious (confirmed from an actual test image: Flux
  // turned "scattered marigold petals" into glowing bokeh orbs that visually
  // fought with the pasted product cutouts). This suffix is enforced in code
  // rather than relying only on the agent's prompt-writing instructions
  // (CONTENT_GEN_PROMPT in insightsAgentTools.js), since Flux's own stylistic
  // defaults (soft bokeh, glow, dreamy light) actively work against a clean
  // compositing surface.
  const compositeBackdropSuffix =
    ", calm uncluttered composition, the lower-middle of the frame is bare " +
    "surface with nothing on it, no bokeh, no lens flare, no glowing light " +
    "orbs, no blur, any props are small physical objects resting flat and " +
    "confined to the edges or top of the frame, sharp focus throughout";

  const prompt =
    buildImagePrompt(campaignName, backdropHint, "", null) +
    compositeBackdropSuffix;

  console.log(
    `[imageGenerationService] Generating composite backdrop for "${campaignName}"`,
  );
  console.log(`[imageGenerationService] Backdrop prompt: ${prompt}`);

  const output = await replicate.run("black-forest-labs/flux-1.1-pro", {
    input: {
      prompt,
      width: 1024,
      height: 1024,
      output_format: "jpg",
      output_quality: 90,
      safety_tolerance: 2,
      prompt_upsampling: false,
    },
  });

  const fluxBackdropUrl = await extractReplicateUrl(output);
  if (!fluxBackdropUrl) {
    throw new Error(
      "[imageGenerationService] Flux did not return a backdrop image URL",
    );
  }

  const backdropBuffer = await fetchImageBuffer(fluxBackdropUrl);

  // Persist the RAW backdrop (no products, no text) to our own storage,
  // separately from the final composite below. Replicate's own URL is a
  // temporary CDN link (~1hr TTL) — not something we can hand back to the
  // frontend to reuse later. Persisting it lets staff edit the eyebrow/
  // headline/badge wording after seeing the generated photo WITHOUT paying
  // for another Flux generation: re-drawing just the text layer over an
  // already-generated backdrop is nearly instant and free (see
  // recomposeCampaignImage below), versus ~5-10s and real API cost per
  // wording tweak if we regenerated the whole scene each time.
  const backdropFileName = `${(campaignName || "campaign").replace(/\s+/g, "_").slice(0, 40)}_${Date.now()}_backdrop.jpg`;
  const backdropUrl = await uploadGeneratedImage(
    backdropBuffer,
    backdropFileName,
  );

  // Fetch + background-remove each real product photo. A failure on any
  // single product (bad URL, unreadable image) is logged and skipped
  // rather than failing the whole campaign image — the caller reports back
  // which titles ended up with no usable cutout so the staff member can be
  // told, same "inform rather than silently degrade" principle used
  // throughout this feature.
  const cutouts = [];
  for (const product of productPhotos) {
    if (!product?.imageUrl) continue;
    try {
      const raw = await fetchImageBuffer(product.imageUrl);
      const cutout = await removeWhiteBackground(raw);
      cutouts.push({ title: product.title, buffer: cutout });
    } catch (err) {
      console.warn(
        `[imageGenerationService] Skipping product photo for "${product.title}" — ${err.message}`,
      );
    }
  }

  if (productPhotos.length > 0 && cutouts.length === 0) {
    console.warn(
      `[imageGenerationService] None of the ${productPhotos.length} product photo(s) could be fetched/processed — falling back to a backdrop-only image.`,
    );
  }

  const finalBuffer = await composeImage({
    backdropBuffer,
    productCutouts: cutouts,
    headline,
    eyebrow,
    badgeText,
    // See hintAlreadyThemed's own comment — confirmed from an actual
    // generated image whose backdropHint asked for "brass diyas... marigold
    // petals... a fairy light string" and which ALSO got composeImage's own
    // decoration layer stacked on top, reading as cluttered.
    skipDecoration: hintAlreadyThemed(backdropHint),
  });

  const fileName = `${(campaignName || "campaign").replace(/\s+/g, "_").slice(0, 40)}_${Date.now()}_composite.jpg`;
  const imageUrl = await uploadGeneratedImage(finalBuffer, fileName);

  const matchedProductTitles = cutouts.map((c) => c.title);
  const unmatchedProductTitles = productPhotos
    .map((p) => p.title)
    .filter((title) => !matchedProductTitles.includes(title));

  console.log(
    `[imageGenerationService] Composite image ready: ${imageUrl} (products used: ${matchedProductTitles.join(", ") || "none"})`,
  );

  return {
    imageUrl,
    backdropUrl,
    prompt,
    matchedProductTitles,
    unmatchedProductTitles,
  };
}

// ── Path B: the real product photo, unmodified — no AI, no text overlay ────
//
// Staff-chosen alternative to generateCompositeCampaignImage (see STEP 2.6 in
// insightsAgentConfig.js — the agent ASKS which path the staff wants
// whenever a real product photo is confirmed, rather than the system
// deciding). This is the literal reading of "just use the real photo":
// no Flux call, no styled backdrop, and — unlike an earlier version of this
// function — NO headline/eyebrow/badge text drawn onto the image either.
// The campaign's body text already carries the message; this path's only
// job is to put the real catalog photo in front of the staff member
// exactly as it is, padded onto a plain white field so it meets WhatsApp's
// 1:1 square header requirement without cropping anything off. No AI
// reinterpretation anywhere, so the product shown is always literally the
// real product.
function buildPlainBackdropSvg(width = 1024, height = 1024) {
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#ffffff" />
    </svg>`,
  );
}

async function generateRawProductCampaignImage({
  campaignName,
  productPhotos = [],
}) {
  console.log(
    `[imageGenerationService] Raw-photo path for "${campaignName}" — no AI generation, ` +
      `no text overlay, products: ${productPhotos.map((p) => p.title).join(", ") || "none"}`,
  );

  const backdropBuffer = await sharp(buildPlainBackdropSvg())
    .jpeg({ quality: 92 })
    .toBuffer();

  // Persisted the same way the AI-scene backdrop is (see
  // generateCompositeCampaignImage's own comment on why) — mainly so the
  // wording-only edit path (recomposeCampaignImage) works identically
  // regardless of which path produced the original image, even though
  // regenerating this particular backdrop costs nothing either way.
  const backdropFileName = `${(campaignName || "campaign").replace(/\s+/g, "_").slice(0, 40)}_${Date.now()}_rawbackdrop.jpg`;
  const backdropUrl = await uploadGeneratedImage(
    backdropBuffer,
    backdropFileName,
  );

  const cutouts = [];
  for (const product of productPhotos) {
    if (!product?.imageUrl) continue;
    try {
      const raw = await fetchImageBuffer(product.imageUrl);
      const cutout = await removeWhiteBackground(raw);
      cutouts.push({ title: product.title, buffer: cutout });
    } catch (err) {
      console.warn(
        `[imageGenerationService] Skipping product photo for "${product.title}" — ${err.message}`,
      );
    }
  }

  // headline/eyebrow/badgeText are deliberately NOT passed here — this is
  // the whole point of this path. With all three null, buildTextBlockSvg
  // (imageCompositingService.js) returns no text layer at all and the
  // product(s) simply get the full canvas, centered, with their own soft
  // drop shadow — a clean product shot, not a poster.
  const finalBuffer = await composeImage({
    backdropBuffer,
    productCutouts: cutouts,
    headline: null,
    eyebrow: null,
    badgeText: null,
    skipDecoration: true,
  });

  const fileName = `${(campaignName || "campaign").replace(/\s+/g, "_").slice(0, 40)}_${Date.now()}_rawcomposite.jpg`;
  const imageUrl = await uploadGeneratedImage(finalBuffer, fileName);

  const matchedProductTitles = cutouts.map((c) => c.title);
  const unmatchedProductTitles = productPhotos
    .map((p) => p.title)
    .filter((title) => !matchedProductTitles.includes(title));

  console.log(
    `[imageGenerationService] Raw-photo image ready: ${imageUrl} (products used: ${matchedProductTitles.join(", ") || "none"})`,
  );

  return {
    imageUrl,
    backdropUrl,
    prompt: null,
    matchedProductTitles,
    unmatchedProductTitles,
  };
}

/**
 * recomposeCampaignImage
 *
 * Re-draws the eyebrow/headline/badge text (and re-composites the product
 * cutouts) over an ALREADY-GENERATED backdrop, without calling Flux again.
 * This is what powers "staff can edit the wording after seeing the image" —
 * the backdrop (the expensive, slow, rate-limited part) is reused as-is;
 * only the cheap sharp/SVG text layer is redone. Typically well under a
 * second, versus 5-10s + a Replicate API call for a full regeneration.
 *
 * @param {object} params
 * @param {string} params.backdropUrl - the persisted backdrop URL returned
 *   by an earlier generateCompositeCampaignImage call (NOT the final
 *   composite URL — that already has products/text baked in)
 * @param {{title:string, imageUrl:string}[]} [params.productPhotos] - same
 *   real catalog photos used the first time around (re-fetched and
 *   re-keyed here; cheap DB/CDN lookups, no AI calls)
 * @param {string} [params.headline]
 * @param {string} [params.eyebrow]
 * @param {string} [params.badgeText]
 * @param {string} [params.campaignName] - only used for the output filename
 * @returns {Promise<{ imageUrl: string }>}
 */
async function recomposeCampaignImage({
  backdropUrl,
  productPhotos = [],
  headline = null,
  eyebrow = null,
  badgeText = null,
  campaignName = "campaign",
}) {
  if (!backdropUrl) {
    throw new Error(
      "[imageGenerationService] recomposeCampaignImage requires backdropUrl",
    );
  }

  const backdropBuffer = await fetchImageBuffer(backdropUrl);

  const cutouts = [];
  for (const product of productPhotos) {
    if (!product?.imageUrl) continue;
    try {
      const raw = await fetchImageBuffer(product.imageUrl);
      const cutout = await removeWhiteBackground(raw);
      cutouts.push({ title: product.title, buffer: cutout });
    } catch (err) {
      console.warn(
        `[imageGenerationService] recompose: skipping product photo for "${product.title}" — ${err.message}`,
      );
    }
  }

  const finalBuffer = await composeImage({
    backdropBuffer,
    productCutouts: cutouts,
    headline,
    eyebrow,
    badgeText,
  });

  const fileName = `${(campaignName || "campaign").replace(/\s+/g, "_").slice(0, 40)}_${Date.now()}_composite.jpg`;
  const imageUrl = await uploadGeneratedImage(finalBuffer, fileName);

  console.log(
    `[imageGenerationService] Recomposed image with updated wording: ${imageUrl}`,
  );

  return { imageUrl };
}

module.exports = {
  generateCampaignImage,
  generateCompositeCampaignImage,
  generateRawProductCampaignImage,
  recomposeCampaignImage,
};
