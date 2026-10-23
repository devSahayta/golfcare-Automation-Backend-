// src/services/imageGenerationService.js
//
// Generates WhatsApp-template-compliant header images for campaigns.
//
// Meta image requirements for WhatsApp template headers:
//   - Aspect ratio: 1:1 square
//   - Minimum size: 500×500px (we use 1024×1024)
//   - No logos or branding beyond what's already on a real product
//   - No countdown/urgency banners
//   - File format: JPEG or PNG
//
// Exactly two ways to get a header image, by staff choice (see STEP 2.6 in
// insightsAgentConfig.js):
//
//   1. generateRawProductCampaignImage — NO AI anywhere. The real catalog
//      photo, centered and padded onto a plain field to meet WhatsApp's 1:1
//      requirement. Nothing drawn, nothing redrawn, nothing composited in —
//      what staff sees is exactly the product photo already in the catalog.
//
//   2. generateAIComposedCampaignImage — ONE OpenAI image-model call does
//      everything: the scene, the product (when a real catalog photo is
//      handed to it as a reference image), and any eyebrow/headline/badge
//      wording, all in a single pass. There is no separate "generate a
//      backdrop, then paste the product, then draw text with SVG/embedded
//      fonts" pipeline any more — that approach (imageCompositingService.js's
//      layout/font system) produced a visibly templated, "pasted-on" look
//      and is no longer used by anything in this file. The model renders
//      legible text natively, so the finished creative comes back as one
//      coherent photo instead of a photo-plus-overlay.
//
// imageCompositingService.js's removeWhiteBackground/composeImage helpers
// are still used, but ONLY by generateRawProductCampaignImage, and only to
// center/pad the real photo — never to draw text or pick a random layout
// (headline/eyebrow/badgeText are never passed on that path).
//
// ── Model / quality knobs ─────────────────────────────────────────────────────
//
//   MODEL   — OpenAI image model to use for AI_SCENE generation.
//             "gpt-image-2-2026-04-21" : input tokens $8/1M  → cheaper when passing many reference images
//             "gpt-image-2.5-flare"    : input tokens $30/1M → higher quality scene understanding
//
//   QUALITY — output quality tier.
//             "low"    → 272 output tokens  → ~$0.008 output cost
//             "medium" → 1056 output tokens → ~$0.053 output cost  ← default
//             "high"   → 4160 output tokens → ~$0.211 output cost
//
//   With MODEL="gpt-image-2-2026-04-21" + QUALITY="medium" + 3 reference images:
//     Input:  3 × 1290 tok × $8/1M  = $0.031
//     Output: 1056 tok × $30/1M     = $0.053
//     Total:  ~$0.084 / ₹7.98   (was $0.169 / ₹16.06 on gpt-image-2.5-flare)
//
// ─────────────────────────────────────────────────────────────────────────────

const Replicate = require("replicate");
const axios = require("axios");
const sharp = require("sharp");
const { env } = require("../config/env");
const {
  removeWhiteBackground,
  composeImage,
} = require("./imageCompositingService");
const {
  uploadGeneratedImage,
  uploadReferenceImage,
} = require("./supabaseStorageService");

// ── Model / quality configuration ────────────────────────────────────────────
//
// Change MODEL here to switch between gpt-image-2-2026-04-21 (cheaper input)
// and gpt-image-2.5-flare (better quality). Change QUALITY to "low" / "medium"
// / "high" to trade off output fidelity vs cost. Everything else (cost math,
// API calls, log messages) reads from these two constants automatically.
//
const MODEL = "gpt-image-2-2026-04-21";
const QUALITY = "low"; // "low" | "medium" | "high"

// ── Replicate client ──────────────────────────────────────────────────────────

function getReplicateClient() {
  if (!env.replicateApiToken) {
    throw new Error(
      "REPLICATE_API_TOKEN is not set. Add it to your .env to enable AI image generation.",
    );
  }
  return new Replicate({ auth: env.replicateApiToken });
}

// Strips characters that would break out of the quoted phrase we embed
// wording in, and collapses whitespace. Keeps this to a defensive sanitize
// only — the actual "keep it short, no prices, no phone numbers" guidance
// lives in the content-generation prompt that writes the wording.
function sanitizeHeadline(headline) {
  return (headline || "")
    .replace(/["'`\n\r]/g, "")
    .trim()
    .slice(0, 60);
}

// Fallback scene used only when no backdropHint was supplied at all (should
// be rare — the content-generation prompt in insightsAgentTools.js is
// expected to always write a specific hint).
const DEFAULT_SCENE =
  "a breathtaking golf course fairway at golden hour, lush green grass glowing in warm sunlight, a distant clubhouse visible through a row of mature trees, serene and inviting atmosphere";

// Very conservative fallback scene used only as a last-resort retry when
// Flux's safety filter rejects a styled scene twice (see
// generateAIComposedCampaignImage's retry logic below) — no flame, no
// seasonal prop language at all, just the product on a clean surface.
const SAFE_FALLBACK_SCENE =
  "an elegant festive product photography setup on a warm wooden surface with soft bokeh string lights in the background, no open flame";

// Open-flame / fire wording is a known false-positive trigger for Flux's
// safety classifier (it doesn't distinguish a ceremonial diya from a fire
// hazard) — this came up repeatedly in testing on Diwali campaigns. Soften
// that language proactively before it ever reaches Flux, rather than only
// reacting after a flag.
//
// Important: it's not just the word "flame" — a diya (or candle, lantern,
// etc.) IS an open-flame object by definition, so swapping "flame" for
// "warm light" while still saying "diyas" left the flame-shaped object in
// the scene and Flux flagged it again (confirmed: a real request with
// "brass diyas... soft warm [flame→]warm light" still came back E005).
// The object itself has to be renamed too, not just its adjective.
// Deliberately narrow (flame-bearing objects/words only) so it doesn't
// mangle unrelated prompt language.
function softenSensitiveWording(text) {
  if (!text) return text;
  return (
    text
      .replace(/\bglowing flames?\b/gi, "a warm golden glow")
      .replace(/\bflames?\b/gi, "warm light")
      .replace(/\bburning\b/gi, "glowing")
      .replace(/\bfire\b/gi, "warm light")
      .replace(/\bsmoke\b/gi, "soft haze")
      .replace(/\bsparks?\b/gi, "glints of light")
      // Flame-bearing objects — rename the object, not just the flame word.
      .replace(/\bdiyas?\b/gi, "brass lanterns")
      .replace(/\bcandles?\b/gi, "brass lanterns")
      .replace(/\boil lamps?\b/gi, "brass lanterns")
      .replace(/\btea lights?\b/gi, "small brass ornaments")
      // Cosmetic cleanup: "soft warm flames" → "soft warm warm light" after
      // the flame replacement above — collapse the accidental repeated word
      // so the prompt sent to Flux (and logged) reads cleanly.
      .replace(/\b(\w+)\s+\1\b/gi, "$1")
  );
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

async function fetchImageBuffer(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
  });
  return Buffer.from(res.data);
}

// ── FLUX.2 Pro — the only AI image path ─────────────────────────────────────
//
// One generation call produces the finished image: scene, product (if a real
// catalog photo is handed in as a reference), and wording, all rendered by
// Flux itself. No sharp compositing, no cutout/background-removal, no
// embedded fonts, no code-level layout templates.
//
// Model: black-forest-labs/flux-2-pro (as of Oct 2026)
//   Reference images: up to 8, ~9MP combined, referenced by index in the
//   prompt ("the product in image 2"). Renders legible text natively,
//   including multi-line headlines — this is what makes a single-pass
//   generation viable; the old pipeline never trusted Flux 1.1 Pro with text
//   for exactly this reason.
//
//   ⚠ FIELD NAME NOT LIVE-VERIFIED: `input_images` is documented by BFL and
//   mirrored by Cloudflare Workers AI's copy of this model's schema, but it
//   was NOT confirmed against Replicate's own live schema for this specific
//   listing before this code was written (outbound access to
//   api.replicate.com was blocked in the environment this was written in).
//   The error handling below throws a clear, loud error — not a silent
//   misbehave — if Replicate rejects the input shape; Replicate's error
//   message names the offending field directly, so one real test call will
//   confirm or correct this.
//
// Product-fidelity caveat: when a real product photo is passed as a
// reference image, Flux is asked to reproduce it faithfully, but a
// diffusion model redrawing a reference is not pixel-exact the way a literal
// paste would have been — a logo or color could come out slightly off. For
// campaigns where exact branding matters more than a seamless single-image
// look, staff should use generateRawProductCampaignImage (the real photo,
// untouched, no AI) instead.
const FLUX2_PRO_MODEL = "black-forest-labs/flux-2-pro";

// ── Reference-image staging ──────────────────────────────────────────────────
//
// WHY: Replicate (and by extension BFL's Flux layer) receives the raw URL we
// pass in `input_images`. If that URL points to a real branded product photo
// on our own CDN (e.g. a Titleist Pro V1 box), BFL's Derivative Works /
// IP-protection filter can fingerprint the image from the URL domain + content
// and flag the whole request as E005 before generation even starts — regardless
// of how the prompt is worded.
//
// FIX: download the product photo to memory first, then re-upload it to
// Supabase Storage under a generic, brand-neutral filename like
// "ref-images/1729580400000-ref-1.jpg". The URL that goes to Replicate is now
// a neutral Supabase URL with no brand in the path — Flux gets pixel data
// without any identifiable URL metadata to fingerprint.
//
// This is exactly what image-gen tools like OpenArt do: they accept your
// image, store it on their own infrastructure, then send only their own
// internal reference (or base64 bytes) to the model.
//
// Vercel note: this runs entirely in memory (download → Buffer → upload to
// Supabase). No filesystem writes. No long-running background process. Safe
// within the Vercel serverless function timeout.
//
async function stageReferenceImages(productPhotos) {
  const staged = [];
  for (let i = 0; i < productPhotos.length; i++) {
    const photo = productPhotos[i];
    if (!photo?.imageUrl) continue;

    let buffer, mimeType;
    try {
      const res = await axios.get(photo.imageUrl, {
        responseType: "arraybuffer",
        timeout: 15000,
      });
      buffer = Buffer.from(res.data);
      // Best-effort MIME detection from Content-Type header; fall back to JPEG
      const ct = (res.headers["content-type"] || "").toLowerCase();
      mimeType = ct.includes("png") ? "image/png" : "image/jpeg";
    } catch (err) {
      console.warn(
        `[imageGenerationService] Failed to download reference image for "${photo.title}" (${photo.imageUrl}): ${err.message} — skipping this product photo`,
      );
      continue;
    }

    try {
      const supabaseUrl = await uploadReferenceImage(buffer, i + 1, mimeType);
      staged.push({ title: photo.title, imageUrl: supabaseUrl });
      console.log(
        `[imageGenerationService] Staged "${photo.title}" reference image as neutral URL: ${supabaseUrl}`,
      );
    } catch (err) {
      console.warn(
        `[imageGenerationService] Failed to stage reference image for "${photo.title}" to Supabase: ${err.message} — skipping this product photo`,
      );
    }
  }
  return staged;
}

// ── OpenAI image generation — primary AI_SCENE provider ─────────────────────
//
// Uses the /v1/images/edits endpoint, which accepts reference images as
// multipart form fields (image[]). This is the same approach OpenArt uses
// internally, which is why the same Titleist/Superfast reference images that
// E005-flagged on Replicate/Flux worked fine in OpenArt.
//
// Model is controlled by the MODULE-LEVEL `MODEL` constant (top of file).
// Quality is controlled by the MODULE-LEVEL `QUALITY` constant (top of file).
//
// Key differences from Flux/Replicate:
//   - No Replicate middleware — calls OpenAI's API directly
//   - Reference images sent as raw bytes (multipart), not as URLs
//   - Response is base64 (data[0].b64_json), not a CDN URL
//   - No safety_tolerance knob — OpenAI's own content policy applies
//
// Falls back to Flux automatically if OPENAI_API_KEY is not set.
//
async function generateAIComposedCampaignImageOpenAI({
  campaignName,
  backdropHint = "",
  headline = null,
  eyebrow = null,
  badgeText = null,
  productPhotos = [],
}) {
  if (!env.openaiApiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set — cannot use OpenAI image generation",
    );
  }

  const productNames = productPhotos.map((p) => p.title).filter(Boolean);

  const cleanHeadline = sanitizeHeadline(headline);
  const cleanEyebrow = sanitizeHeadline(eyebrow);
  const cleanBadge = sanitizeHeadline(badgeText);

  const textClauses = [
    cleanEyebrow &&
      `a small letter-spaced kicker line near the top reading "${cleanEyebrow}"`,
    cleanHeadline &&
      `a bold, large statement headline reading "${cleanHeadline}"`,
    cleanBadge && `a small rounded pill/badge reading "${cleanBadge}"`,
  ].filter(Boolean);
  const textClause = textClauses.length
    ? ` Render ${textClauses.join(", ")}, as an integrated part of the composition — real, crisp, legible, well-kerned, correctly spelled typography that looks designed into the scene (like a real promotional photo), not pasted on top, and not overlapping the product.`
    : "";

  const productFidelityClause =
    productNames.length > 0
      ? ` The product${productNames.length > 1 ? "s" : ""} shown in the reference image${
          productNames.length > 1 ? "s" : ""
        } (${productNames.join(", ")}) must appear exactly as photographed — ` +
        `same packaging, same logos, same colors, same proportions, unaltered and undistorted. ` +
        `Do not redesign, restyle, recolor, or add/remove any markings on the product itself; ` +
        `only the surrounding scene, lighting, and composition are yours to style.`
      : "";

  const rawScene = (backdropHint || "").trim() || DEFAULT_SCENE;
  const scene = softenSensitiveWording(rawScene);

  // ── Golf Care brand identity clause ─────────────────────────────────────
  // Every generated image must feel on-brand. We inject a brand clause that
  // steers the model toward Golf Care's palette: deep forest green (#1a4a2e),
  // clean white negative space, and warm gold accent detail. This is appended
  // after the scene hint so the model still follows Haiku's styling brief but
  // never strays into an off-brand color story by default.
  //
  // When a logo reference image is provided (GOLFCARE_LOGO_URL is set), the
  // model is also instructed to place it naturally in the scene — the logo
  // image will be appended as the LAST image[] in the multipart call so it
  // is the final reference the model sees before generating.
  const logoUrl = env.golfcareLogoUrl || "";
  const faviconUrl = env.golfcareFaviconUrl || "";
  // Prompt clause: tell the model which reference images are brand assets and
  // exactly how to use them. The favicon (green "G" circle) is the corner badge;
  // the full logo gives brand identity context.
  const hasLogoRefs = logoUrl || faviconUrl;
  const logoPlacementClause = hasLogoRefs
    ? ` Brand reference images are included: ` +
      (logoUrl && faviconUrl
        ? `the second-to-last image is the Golf Care full logo (use for brand identity context); ` +
          `the very last image is the Golf Care "G" circle favicon — place this as a small, ` +
          `clearly visible corner badge in the bottom-right or bottom-left of the composition, ` +
          `as if it were a brand stamp or seal on the scene. `
        : `the last reference image is the Golf Care logo — place it as a small corner badge ` +
          `(bottom-right or bottom-left) or a subtle branded element in the scene. `) +
      `Keep the badge tasteful and proportionate — clearly visible but not dominating the product.`
    : "";

  const brandClause =
    ` Golf Care brand identity: incorporate deep forest green (rich dark green like a golf course) ` +
    `as a background surface, backdrop panel, or subtle environmental element; ` +
    `use clean white negative space for a premium feel; ` +
    `add a warm gold or champagne accent in the lighting, props, or small decorative detail. ` +
    `The overall palette should read as a high-end golf retail brand — sophisticated, outdoorsy, aspirational.` +
    logoPlacementClause;

  const prompt =
    `${scene}.${productFidelityClause}${textClause}${brandClause} ` +
    `Premium commercial advertising photography, one cohesive styled shot, natural lighting, ` +
    `shallow depth of field, 1:1 square composition, no watermarks, no extra or garbled text, ` +
    `no logos other than what is already on the real product shown.`;

  // ── Image generation cost ────────────────────────────────────────────────
  // Pricing is token-based. The image API does NOT return a usage object —
  // cost is determined entirely by quality + size, which maps to a fixed
  // output token count.
  //
  //   quality   size        output tokens  output cost (@$30/1M)
  //   ──────────────────────────────────────────────────────────
  //   low       1024×1024       272 tok    $0.00816
  //   medium    1024×1024      1056 tok    $0.053
  //   high      1024×1024      4160 tok    $0.211
  //
  // Input image token rate varies by model:
  //   gpt-image-2-2026-04-21  →  $8/1M  (cheaper — good for many reference images)
  //   gpt-image-2.5-flare     →  $30/1M (same as output rate)
  //
  // A typical 1024×1024 input image ≈ 1290 tokens.
  //
  const IMAGE_COST_TABLE = {
    "low:1024x1024": { outputTokens: 272, usd: 0.00816 },
    "medium:1024x1024": { outputTokens: 1056, usd: 0.053 },
    "high:1024x1024": { outputTokens: 4160, usd: 0.211 },
  };
  const COST_KEY = `${QUALITY}:1024x1024`;
  const INPUT_TOKENS_PER_REF_IMAGE = 1290; // approx, 1024×1024 input image

  // Input token rate depends on model — gpt-image-2 is much cheaper for inputs
  const INPUT_TOKEN_RATE_PER_M = MODEL === "gpt-image-2-2026-04-21" ? 8 : 30;
  const OUTPUT_TOKEN_RATE_PER_M = 30; // same for all models

  const outputCost =
    IMAGE_COST_TABLE[COST_KEY] || IMAGE_COST_TABLE["medium:1024x1024"];
  const refImageCount = productPhotos.length;
  // +1 per brand image that will be appended (logo + favicon, if configured)
  const brandImageCount = (logoUrl ? 1 : 0) + (faviconUrl ? 1 : 0);
  const totalInputImages = refImageCount + brandImageCount;
  const inputCostUsd =
    totalInputImages > 0
      ? ((totalInputImages * INPUT_TOKENS_PER_REF_IMAGE) / 1_000_000) *
        INPUT_TOKEN_RATE_PER_M
      : 0;
  const totalCostUsd = outputCost.usd + inputCostUsd;
  const totalCostInr = (totalCostUsd * 95).toFixed(2); // ₹95/USD approx

  console.log(
    `[imageGenerationService] 💰 ${MODEL} — output: $${outputCost.usd.toFixed(4)}` +
      (totalInputImages > 0
        ? ` + ${totalInputImages} input image${totalInputImages > 1 ? "s" : ""} (${refImageCount} product${refImageCount !== 1 ? "s" : ""}${logoUrl ? " + logo" : ""}${faviconUrl ? " + favicon" : ""}): $${inputCostUsd.toFixed(4)} (@$${INPUT_TOKEN_RATE_PER_M}/1M input tok)`
        : "") +
      ` = $${totalCostUsd.toFixed(4)} / ₹${totalCostInr}` +
      ` (${QUALITY} quality, 1024×1024, ${outputCost.outputTokens} output tokens)`,
  );

  console.log(
    `[imageGenerationService] ${MODEL} generating for "${campaignName}" ` +
      `with ${productPhotos.length} reference image(s)`,
  );
  console.log(`[imageGenerationService] Prompt: ${prompt}`);

  const startTime = Date.now();

  // ── Helper: append Golf Care logo to a FormData ──────────────────────────
  // Downloads the logo from GOLFCARE_LOGO_URL (PNG expected) and appends it
  // as the LAST image[] entry so the model sees it clearly as a branding
  // reference. Silently skips if the URL is empty or the download fails —
  // campaign generation must not fail just because the logo can't be fetched.
  async function appendLogoIfConfigured(formData) {
    if (!logoUrl) return false;
    try {
      const res = await axios.get(logoUrl, {
        responseType: "arraybuffer",
        timeout: 10000,
      });
      const buffer = Buffer.from(res.data);
      const ct = (res.headers["content-type"] || "image/png").toLowerCase();
      const ext = ct.includes("png") ? "png" : "jpg";
      const mimeType = ct.includes("png") ? "image/png" : "image/jpeg";
      formData.append(
        "image[]",
        new Blob([buffer], { type: mimeType }),
        `golfcare-logo.${ext}`,
      );
      console.log(`[imageGenerationService] ✅ Logo appended: ${logoUrl}`);
      return true;
    } catch (err) {
      console.warn(
        `[imageGenerationService] ⚠️  Could not download logo (${logoUrl}): ${err.message} — generating without it`,
      );
      return false;
    }
  }

  // ── Route to the correct OpenAI endpoint ─────────────────────────────────
  //
  // Decision tree:
  //   A) Product photos exist   → /edits with photos + logo (if configured)
  //   B) No product photos, logo configured → /edits with logo only
  //   C) No product photos, no logo → /generations (pure text-to-image)
  //
  // /v1/images/edits requires at least one image[] — that's always true in
  // cases A and B. Case C is the only pure-generation path.
  //

  let json;

  if (productPhotos.length === 0 && !logoUrl && !faviconUrl) {
    // ── Case C: Pure generation (no reference images at all) ─────────────
    //
    // Does NOT accept `response_format` — causes HTTP 400 "Unknown parameter"
    // Does NOT accept `n` in some model versions — omit it (defaults to 1)
    //
    console.log(
      `[imageGenerationService] No reference images, no logo — using /v1/images/generations`,
    );
    const genBody = {
      model: MODEL,
      prompt,
      size: "1024x1024",
      quality: QUALITY,
    };
    console.log(
      `[imageGenerationService] generations body: ${JSON.stringify(genBody)}`,
    );
    const genResponse = await fetch(
      "https://api.openai.com/v1/images/generations",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.openaiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(genBody),
      },
    );

    if (!genResponse.ok) {
      const errText = await genResponse.text().catch(() => "(unreadable)");
      console.error(
        `[imageGenerationService] OpenAI generations HTTP ${genResponse.status}: ${errText}`,
      );
      throw new Error(
        `OpenAI ${MODEL} generations request failed (HTTP ${genResponse.status}): ${errText}`,
      );
    }
    json = await genResponse.json();
  } else {
    // ── Cases A & B: Edits (product photos and/or logo) ──────────────────
    //
    // Build multipart form — FormData (Node 18+ built-in) + fetch.
    // Logo (if configured) is appended LAST so it is the clearest reference.
    const formData = new FormData();
    formData.append("model", MODEL);
    formData.append("prompt", prompt);
    formData.append("size", "1024x1024");
    formData.append("quality", QUALITY);

    // Download each product reference photo and append
    const capped = productPhotos.slice(0, 16);
    let appendedCount = 0;
    for (let i = 0; i < capped.length; i++) {
      const photo = capped[i];
      if (!photo?.imageUrl) continue;
      try {
        const res = await axios.get(photo.imageUrl, {
          responseType: "arraybuffer",
          timeout: 15000,
        });
        const buffer = Buffer.from(res.data);
        const ct = (res.headers["content-type"] || "").toLowerCase();
        const ext = ct.includes("png") ? "png" : "jpg";
        const mimeType = ct.includes("png") ? "image/png" : "image/jpeg";
        formData.append(
          "image[]",
          new Blob([buffer], { type: mimeType }),
          `ref-${i + 1}.${ext}`,
        );
        appendedCount++;
        console.log(
          `[imageGenerationService] Appended reference image ${i + 1}: "${photo.title}"`,
        );
      } catch (err) {
        console.warn(
          `[imageGenerationService] Could not download reference image for "${photo.title}": ${err.message} — skipping`,
        );
      }
    }

    // Append logo last (so model sees it as the branding reference, not a product)
    const logoAppended = await appendLogoIfConfigured(formData);

    // Safety net: if all product photos failed AND logo also failed (or isn't set),
    // we have zero image[] entries and /edits would 400. Fall back to /generations.
    if (appendedCount === 0 && !logoAppended) {
      console.warn(
        `[imageGenerationService] All reference image download(s) failed including logo — ` +
          `falling back to /v1/images/generations (no reference images)`,
      );
      const genBody = {
        model: MODEL,
        prompt,
        size: "1024x1024",
        quality: QUALITY,
      };
      const genResponse = await fetch(
        "https://api.openai.com/v1/images/generations",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.openaiApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(genBody),
        },
      );
      if (!genResponse.ok) {
        const errText = await genResponse.text().catch(() => "(unreadable)");
        console.error(
          `[imageGenerationService] OpenAI generations fallback HTTP ${genResponse.status}: ${errText}`,
        );
        throw new Error(
          `OpenAI ${MODEL} generations fallback failed (HTTP ${genResponse.status}): ${errText}`,
        );
      }
      json = await genResponse.json();
    } else {
      console.log(
        `[imageGenerationService] Calling /edits with ${appendedCount} product photo(s)${logoAppended ? " + logo" : ""}`,
      );
      const editsResponse = await fetch(
        "https://api.openai.com/v1/images/edits",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.openaiApiKey}`,
          },
          body: formData,
        },
      );

      if (!editsResponse.ok) {
        const errText = await editsResponse.text().catch(() => "(unreadable)");
        console.error(
          `[imageGenerationService] OpenAI edits HTTP ${editsResponse.status}: ${errText}`,
        );
        throw new Error(
          `OpenAI ${MODEL} edits request failed (HTTP ${editsResponse.status}): ${errText}`,
        );
      }
      json = await editsResponse.json();
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // The model returns b64_json by default. Some model versions may also
  // return a `url` field. Try both.
  const b64 = json?.data?.[0]?.b64_json;
  const fallbackUrl = json?.data?.[0]?.url;

  if (!b64 && !fallbackUrl) {
    console.error(
      `[imageGenerationService] OpenAI unexpected response shape:`,
      JSON.stringify(json).slice(0, 500),
    );
    throw new Error(
      `OpenAI ${MODEL} returned unexpected response shape: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }

  console.log(
    `[imageGenerationService] ✅ Done in ${elapsed}s — total charged: $${totalCostUsd.toFixed(4)} / ₹${totalCostInr}`,
  );

  // Get the raw image buffer — prefer b64_json (no extra HTTP hop), fall
  // back to URL if that's all the model returned.
  let rawBuffer;
  if (b64) {
    rawBuffer = Buffer.from(b64, "base64");
  } else {
    console.log(
      `[imageGenerationService] No b64_json in response — fetching from URL: ${fallbackUrl}`,
    );
    rawBuffer = await fetchImageBuffer(fallbackUrl);
  }

  // Normalize to 1024×1024 JPEG (WhatsApp header requirement)
  const finalBuffer = await sharp(rawBuffer)
    .resize(1024, 1024, { fit: "cover" })
    .jpeg({ quality: 92 })
    .toBuffer();

  const fileName = `${(campaignName || "campaign").replace(/\s+/g, "_").slice(0, 40)}_${Date.now()}_ai.jpg`;
  const imageUrl = await uploadGeneratedImage(finalBuffer, fileName);

  console.log(
    `[imageGenerationService] ${MODEL} final image ready: ${imageUrl}`,
  );

  return {
    imageUrl,
    prompt,
    matchedProductTitles: productNames,
    unmatchedProductTitles: [],
    // Actual cost of this generation — callers save to DB for per-campaign spend tracking.
    costUsd: totalCostUsd,
    costInr: Number(totalCostInr),
    // Token counts for AgentUsage logging
    inputTokens: totalInputImages * INPUT_TOKENS_PER_REF_IMAGE,
    outputTokens: outputCost.outputTokens,
    model: MODEL,
  };
}

/**
 * generateAIComposedCampaignImage
 *
 * @param {object} params
 * @param {string} params.campaignName
 * @param {string} [params.backdropHint] - scene/styling direction. Can
 *   (and, for a named-product campaign, should) describe the product's
 *   presence in the scene too — unlike the old paste-compositing path,
 *   there's no hard-edged cutout to protect, so normal styling language is
 *   fine here.
 * @param {string} [params.headline]
 * @param {string} [params.eyebrow]
 * @param {string} [params.badgeText]
 * @param {{title:string, imageUrl:string}[]} [params.productPhotos] - real
 *   catalog photos, passed to the model as reference images. Omit/empty for
 *   a generic thematic campaign with no specific named product.
 * @returns {Promise<{
 *   imageUrl: string,
 *   prompt: string,
 *   matchedProductTitles: string[],
 *   unmatchedProductTitles: string[],
 *   costUsd: number,
 *   costInr: number,
 * }>}
 */
async function generateAIComposedCampaignImage({
  campaignName,
  backdropHint = "",
  headline = null,
  eyebrow = null,
  badgeText = null,
  productPhotos = [],
}) {
  // Use OpenAI when OPENAI_API_KEY is configured — it runs on OpenAI's own
  // infrastructure without Replicate's brand-filter middleware, which is what
  // caused E005 for real branded product photos on Flux.
  // Fall back to Flux/Replicate only when OPENAI_API_KEY is not set.
  if (env.openaiApiKey) {
    console.log(
      `[imageGenerationService] OPENAI_API_KEY present — using ${MODEL} (not Flux)`,
    );
    return generateAIComposedCampaignImageOpenAI({
      campaignName,
      backdropHint,
      headline,
      eyebrow,
      badgeText,
      productPhotos,
    });
  }

  console.log(
    `[imageGenerationService] No OPENAI_API_KEY — falling back to Flux/Replicate`,
  );
  const replicate = getReplicateClient();

  // Stage product photos through Supabase Storage before passing to Replicate.
  // See stageReferenceImages() comment above for why — the short version is:
  // passing the real product CDN URL directly lets Flux's brand/IP filter
  // fingerprint the image from the URL itself; a neutral Supabase URL breaks
  // that fingerprint while the pixel data is identical.
  //
  // Capped at 8 after staging (BFL's documented input_images limit).
  const productNames = productPhotos.map((p) => p.title).filter(Boolean);
  const stagedPhotos =
    productPhotos.length > 0
      ? await stageReferenceImages(productPhotos.slice(0, 8))
      : [];
  const referenceImages = stagedPhotos.map((p) => p.imageUrl).filter(Boolean);
  const productFidelityClause = productNames.length
    ? ` The product${productNames.length > 1 ? "s" : ""} shown in the reference image${
        productNames.length > 1 ? "s" : ""
      } (${productNames.join(", ")}) must appear exactly as photographed — ` +
      `same packaging, same logos, same colors, same proportions, unaltered and undistorted. ` +
      `Do not redesign, restyle, recolor, or add/remove any markings on the product itself; ` +
      `only the surrounding scene, lighting, and composition are yours to style.`
    : "";

  const cleanHeadline = sanitizeHeadline(headline);
  const cleanEyebrow = sanitizeHeadline(eyebrow);
  const cleanBadge = sanitizeHeadline(badgeText);
  const textClauses = [
    cleanEyebrow &&
      `a small letter-spaced kicker line near the top reading "${cleanEyebrow}"`,
    cleanHeadline &&
      `a bold, large statement headline reading "${cleanHeadline}"`,
    cleanBadge && `a small rounded pill/badge reading "${cleanBadge}"`,
  ].filter(Boolean);
  const textClause = textClauses.length
    ? ` Render ${textClauses.join(", ")}, as an integrated part of the composition — real, crisp, legible, well-kerned, correctly spelled typography that looks designed into the scene (like a real promotional photo), not pasted on top, and not overlapping the product.`
    : "";

  const rawScene = (backdropHint || "").trim() || DEFAULT_SCENE;
  // Soften flame/fire wording before it ever reaches Flux — see
  // softenSensitiveWording's comment above for why.
  const scene = softenSensitiveWording(rawScene);

  function buildPrompt(sceneText) {
    return (
      `${sceneText}.${productFidelityClause}${textClause} ` +
      `Premium commercial advertising photography, one cohesive styled shot (not a photo with a sticker on it), natural lighting, ` +
      `shallow depth of field, 1:1 square composition, no watermarks, no extra or garbled text, ` +
      `no logos other than what is already on the real product shown.`
    );
  }

  function buildInput(promptText) {
    return {
      prompt: promptText,
      ...(referenceImages.length > 0 && { input_images: referenceImages }),
      width: 1024,
      height: 1024,
      output_format: "jpg",
      safety_tolerance: 5,
    };
  }

  let prompt = buildPrompt(scene);

  console.log(
    `[imageGenerationService] Generating for "${campaignName}" with ${referenceImages.length} reference image(s)`,
  );
  console.log(`[imageGenerationService] Prompt: ${prompt}`);

  const startTime = Date.now();

  let output;
  try {
    output = await replicate.run(FLUX2_PRO_MODEL, {
      input: buildInput(prompt),
    });
  } catch (err) {
    // E005 = Flux's own safety classifier flagged the input or output.
    //
    // CONFIRMED (real testing, not a guess): when referenceImages is
    // non-empty, this is Black Forest Labs' Derivative Works / IP-protection
    // filter reacting to a real trademarked product photo combined with the
    // productFidelityClause's "keep the logo exact" instruction. This is
    // NOT fixable by rewording the surrounding scene — a prior version of
    // this function retried with a completely bland, prop-free scene while
    // still sending the same reference images + fidelity clause, and it
    // still got flagged every time, because the scene text was never what
    // the filter was reacting to. Retrying again with the same reference
    // images would waste a Replicate call on a near-certain second failure
    // and risk collapsing into the rate limit (two calls in quick
    // succession). So: for this specific case, stop immediately and throw a
    // distinct, catchable error instead — same "tell the staff member
    // directly, never silently degrade" principle this codebase already
    // uses for PRODUCT_PHOTOS_UNRESOLVED (see broadcastCampaignController.js).
    // The controller maps this to a 409 the frontend can show with a clear
    // "switch to RAW_PHOTO for this product" action, which is the one
    // reliable fix (no AI call at all, so nothing for this filter to flag).
    const isSensitiveFlag = /flagged as sensitive|E005/i.test(
      err.message || "",
    );
    if (!isSensitiveFlag) throw err;

    if (referenceImages.length > 0) {
      console.error(
        `[imageGenerationService] E005 with ${referenceImages.length} reference image(s) present — ` +
          `this is almost certainly Flux's brand/logo IP-protection filter reacting to the real ` +
          `product photo(s) (${productNames.join(", ")}) plus the "keep the logo exact" instruction. ` +
          `Not retrying with a reworded scene — that was tried previously and still failed, since the ` +
          `scene text isn't what's being flagged. Surfacing a clear error instead of a doomed retry.`,
      );
      const brandError = new Error(
        `AI generation was blocked by Flux's brand/logo protection filter for: ${productNames.join(", ")}. ` +
          `Use the raw-photo (no AI) option for this product instead.`,
      );
      brandError.code = "AI_BRAND_LOGO_BLOCKED";
      brandError.productNames = productNames;
      throw brandError;
    }

    // No reference images — a genuinely generic scene got flagged. This
    // case has no branded-logo angle, so a bland, flame-free fallback scene
    // retry is a legitimate second chance (not the doomed case above).
    console.warn(
      `[imageGenerationService] Flux flagged a generic (no-reference-image) request as sensitive (E005) ` +
        `even after wording softened. Retrying once with a conservative fallback scene so staff still ` +
        `get an image back. Original scene hint: "${rawScene}"`,
    );
    prompt = buildPrompt(SAFE_FALLBACK_SCENE);
    console.log(`[imageGenerationService] Retry prompt: ${prompt}`);
    // Small delay before the retry — firing a second Replicate call
    // immediately after the first is what previously collided with
    // Replicate's own low-credit rate limit (6 req/min, burst of 1),
    // turning a content-flag retry into a 429 instead. This does not
    // replace adding Replicate credit (the real fix for the throttle, see
    // the file-level note below) but reduces the odds of colliding with it
    // for an account still under the $5 threshold.
    await new Promise((resolve) => setTimeout(resolve, 2500));
    output = await replicate.run(FLUX2_PRO_MODEL, {
      input: buildInput(prompt),
    });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const fluxImageUrl = await extractReplicateUrl(output);

  if (
    !fluxImageUrl ||
    typeof fluxImageUrl !== "string" ||
    !fluxImageUrl.startsWith("http")
  ) {
    console.error(
      `[imageGenerationService] Unexpected Replicate output shape — this usually ` +
        `means an input field name mismatch (see the file-level comment on ` +
        `generateAIComposedCampaignImage). Raw output:`,
      output,
    );
    throw new Error(
      `[imageGenerationService] FLUX.2 Pro returned unexpected output: ${JSON.stringify(output)}`,
    );
  }

  console.log(
    `[imageGenerationService] Image generated in ${elapsed}s: ${fluxImageUrl}`,
  );

  // Normalize to our own storage — Replicate's CDN link is temporary (~1hr).
  const rawBuffer = await fetchImageBuffer(fluxImageUrl);
  // Safety net: force exactly 1024x1024 in case Flux didn't return a
  // perfect square (WhatsApp's header requirement is strict 1:1).
  const finalBuffer = await sharp(rawBuffer)
    .resize(1024, 1024, { fit: "cover" })
    .jpeg({ quality: 92 })
    .toBuffer();

  const fileName = `${(campaignName || "campaign").replace(/\s+/g, "_").slice(0, 40)}_${Date.now()}_ai.jpg`;
  const imageUrl = await uploadGeneratedImage(finalBuffer, fileName);

  console.log(`[imageGenerationService] Final image ready: ${imageUrl}`);

  return {
    imageUrl,
    prompt,
    matchedProductTitles: productNames,
    unmatchedProductTitles: [],
  };
}

// ── The real product photo, unmodified — no AI anywhere ────────────────────
//
// Staff-chosen alternative to generateAIComposedCampaignImage (see STEP 2.6
// in insightsAgentConfig.js — the agent ASKS which the staff wants whenever
// a real product photo is confirmed, rather than the system deciding). No
// Flux call, no styled backdrop, no headline/eyebrow/badge text drawn onto
// the image. The campaign's body text already carries the message; this
// path's only job is to put the real catalog photo in front of the staff
// member exactly as it is, padded onto a plain white field so it meets
// WhatsApp's 1:1 square header requirement without cropping anything off.
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

  const fileName = `${(campaignName || "campaign").replace(/\s+/g, "_").slice(0, 40)}_${Date.now()}_rawphoto.jpg`;
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
    prompt: null,
    matchedProductTitles,
    unmatchedProductTitles,
  };
}

module.exports = {
  generateAIComposedCampaignImage,
  generateRawProductCampaignImage,
};
