// src/services/imageGenerationService.js
//
// Generates WhatsApp-template-compliant header images using Flux 1.1 Pro
// via the Replicate API.
//
// Meta image requirements for WhatsApp template headers:
//   - Aspect ratio: 1:1 square
//   - Minimum size: 500×500px (we use 1024×1024)
//   - No text overlays (causes rejection)
//   - No logos or branding
//   - No promotional graphics (price tags, sale banners)
//   - Clean photographic / naturalistic scenes
//   - File format: JPEG or PNG
//
// Model: black-forest-labs/flux-1.1-pro
//   Cost: ~$0.004/image  |  Output: 1024×1024 JPEG URL  |  Latency: 5–10s
//
// Usage:
//   const { generateCampaignImage } = require('./imageGenerationService');
//   const { imageUrl } = await generateCampaignImage({ campaignName, intent, context });

const Replicate = require("replicate");
const { env } = require("../config/env");

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

const SAFE_SUFFIX = [
  "photorealistic photography",
  "professional DSLR camera",
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
    keywords: ["ball", "balls", "range"],
    scene:
      "crisp white golf balls arranged on a perfectly manicured green next to a flagstick, shallow depth of field, lush fairway background",
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

function buildImagePrompt(campaignName, intent, context) {
  const searchText = `${campaignName} ${intent} ${context}`.toLowerCase();

  let chosenScene = DEFAULT_SCENE;
  for (const entry of SCENE_MAP) {
    if (entry.keywords.some((kw) => searchText.includes(kw))) {
      chosenScene = entry.scene;
      break;
    }
  }

  // Final prompt: scene description + Meta-safe constraints
  return `${chosenScene}, ${SAFE_SUFFIX}`;
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
 * Generates a Meta-compliant 1024×1024 golf scene image using Flux 1.1 Pro.
 *
 * @param {object} params
 * @param {string} params.campaignName  - Campaign name (used for scene selection)
 * @param {string} params.intent        - Campaign intent (e.g. "golf tournament announcement")
 * @param {string} [params.context]     - Extra context (venue, date, etc.)
 * @returns {Promise<{ imageUrl: string, prompt: string }>}
 */
async function generateCampaignImage({ campaignName, intent, context = "" }) {
  const replicate = getReplicateClient();
  const prompt = buildImagePrompt(campaignName, intent, context);

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
  let imageUrl = await extractReplicateUrl(output);

  if (
    !imageUrl ||
    typeof imageUrl !== "string" ||
    !imageUrl.startsWith("http")
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
    `[imageGenerationService] Image generated in ${elapsed}s: ${imageUrl}`,
  );

  return { imageUrl, prompt };
}

module.exports = { generateCampaignImage };
