// src/services/imageCompositingService.js
//
// Pastes your REAL product photos onto an AI-generated backdrop, instead of
// asking an image-to-image model to redraw the products. This is the
// deliberate architecture choice for the "use our actual products" feature:
// diffusion-based image-to-image models (Flux Kontext etc.) regenerate
// pixels, which risks distorting logos, colors, and packaging text on real
// branded products — exactly the opposite of "the product in the image has
// to be ours". Compositing guarantees the product pixels are untouched;
// only the backdrop and the caption text/badge are AI/code-generated.
//
// Pipeline (see imageGenerationService.generateCompositeCampaignImage):
//   1. Flux generates a backdrop ONLY — no products described in the prompt
//   2. Each real product photo gets its background keyed out (this version:
//      a cheap white/near-white threshold — most catalog shots are plain
//      studio photos, so this is usually enough; a photo with a busy/colored
//      background will show a visible edge until a proper ML background
//      remover is added later)
//   3. Cutouts are laid out on the backdrop with a soft drop shadow so they
//      read as "placed" rather than "pasted"
//   4. The text block (eyebrow + headline + badge, any of which are
//      optional) is rendered as real typography via SVG + sharp — not asked
//      of Flux, which is unreliable at legible text. This is strictly more
//      reliable than the text-in-Flux-prompt approach used for campaigns
//      with no specific named products.
//
// FONT NOTE (local-vs-production parity): the text is rendered with a font
// embedded directly in the SVG as a base64 data URI (see loadEmbeddedFonts
// below), not a font name like "Georgia" that depends on whatever's
// installed on the machine. This matters a lot here specifically because
// this service runs both on a developer's Windows machine (which has
// Georgia/Times New Roman installed) AND as a Vercel serverless function
// (a minimal Linux image that does NOT have those fonts, or in most cases
// ANY font, installed system-wide). Without embedding, the exact same code
// renders correctly-styled text locally and then silently falls back to a
// generic default face (or even invisible/empty text, depending on the
// libvips/librsvg build) in production — a "works on my machine" bug that's
// invisible until the owner tests the deployed site. Embedding the font
// bytes in the SVG itself removes the dependency on the host entirely.

const sharp = require("sharp");
const {
  MONTSERRAT_800_WOFF_BASE64,
  MONTSERRAT_600_WOFF_BASE64,
} = require("../assets/fonts/embeddedFonts");

const CANVAS_SIZE = 1024;

// ── Embedded fonts ───────────────────────────────────────────────────────────
//
// Montserrat (SIL Open Font License — free to bundle), ExtraBold for the
// headline/badge and SemiBold for the smaller eyebrow line, inlined as base64
// JS constants (see embeddedFonts.js for why this is a plain JS module and
// not .woff files read off disk — in short: Vercel serverless function
// bundling can silently drop non-JS asset files that aren't referenced by a
// literal require()/import, which would work locally and 500 in production).
const MONTSERRAT_800_B64 = MONTSERRAT_800_WOFF_BASE64 || null;
const MONTSERRAT_600_B64 = MONTSERRAT_600_WOFF_BASE64 || null;

// Built once. If a font failed to load, its @font-face rule is just omitted
// — the SVG still renders, falling back to librsvg's default face rather
// than crashing, and the console warning above explains why it looks off.
const FONT_FACE_CSS = `
  <style>
    ${MONTSERRAT_800_B64 ? `@font-face { font-family: 'GCHeadline'; src: url(data:font/woff;base64,${MONTSERRAT_800_B64}) format('woff'); font-weight: 800; }` : ""}
    ${MONTSERRAT_600_B64 ? `@font-face { font-family: 'GCEyebrow'; src: url(data:font/woff;base64,${MONTSERRAT_600_B64}) format('woff'); font-weight: 600; }` : ""}
  </style>
`;
const HEADLINE_FONT_FAMILY = MONTSERRAT_800_B64
  ? "'GCHeadline', sans-serif"
  : "sans-serif";
const EYEBROW_FONT_FAMILY = MONTSERRAT_600_B64
  ? "'GCEyebrow', sans-serif"
  : "sans-serif";

// ── Background removal (white-key) ──────────────────────────────────────────
//
// Soft-threshold chroma key: instead of a hard on/off cutoff at `threshold`,
// alpha ramps smoothly from fully opaque (at `threshold - feather`) to fully
// transparent (at `threshold`), based on the pixel's "whiteness" — how close
// its darkest channel is to white. A hard cutoff left a visible fringe/halo
// around cutouts (confirmed from an actual test image — the white box edge
// in a composited Diwali gift box photo had a rough light-colored outline).
// Feathering the last few brightness levels before the cutoff blends the
// product edge into whatever it's placed on instead of leaving a hard ring.
async function removeWhiteBackground(
  inputBuffer,
  { threshold = 235, feather = 18 } = {},
) {
  const { data, info } = await sharp(inputBuffer)
    // .rotate() with no args auto-orients using the photo's EXIF tag before
    // anything else touches it. Without this, sharp's raw pixel buffer (and
    // every width/height read from it downstream) can come out rotated
    // 90°/270° from how the photo actually looks — a real cause of the
    // "Image to composite must have same dimensions or smaller" crash,
    // since a portrait catalog photo can report landscape dimensions.
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info; // channels is 4 after ensureAlpha
  const floor = threshold - feather;
  for (let i = 0; i < data.length; i += channels) {
    const whiteness = Math.min(data[i], data[i + 1], data[i + 2]);
    if (whiteness >= threshold) {
      data[i + 3] = 0;
    } else if (whiteness > floor) {
      // Linear ramp: whiteness==floor -> alpha stays as-is (opaque edge),
      // whiteness==threshold -> alpha 0. Scales the EXISTING alpha down
      // rather than assuming it was 255, so this still behaves on a source
      // PNG that already had partial transparency.
      const t = (whiteness - floor) / feather; // 0..1
      data[i + 3] = Math.round(data[i + 3] * (1 - t));
    }
  }

  // Crop away the now-transparent border. Catalog photos almost always have
  // generous white margin around the actual product (studio shots are
  // rarely cropped tight), and since keying out the background only makes
  // those margin pixels transparent — it doesn't shrink the canvas — every
  // downstream resize-to-target-height was scaling a bunch of invisible
  // padding right along with the product. A bag photographed with 30%
  // padding on each side was effectively rendered at ~40% of its intended
  // size. trim() crops to the actual opaque content's bounding box, so the
  // product itself — not its padding — fills the space we give it.
  return sharp(data, { raw: { width, height, channels } })
    .trim({ threshold: 10 })
    .png()
    .toBuffer();
}

// ── Contact shadow ───────────────────────────────────────────────────────────
//
// A simple dark ellipse, heavily blurred, placed at a cutout's base. This is
// what actually grounds a hard-edged pasted product against a busy backdrop
// — the silhouette drop shadow below is good for close detail but reads as
// a faint afterthought once the backdrop has any texture behind it
// (confirmed from an actual test image: the composited products looked
// like they were floating with no contact shadow legible at all). A product
// photography compositing trick: a blurred ellipse under the base is far
// more visually convincing than a precise silhouette at this image size.
function buildContactShadowSvg(width, height) {
  const cx = width / 2;
  const cy = height * 0.92;
  const rx = width * 0.42;
  const ry = height * 0.07;
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="contact" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#000000" stop-opacity="0.55" />
          <stop offset="70%" stop-color="#000000" stop-opacity="0.25" />
          <stop offset="100%" stop-color="#000000" stop-opacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#contact)" />
    </svg>
  `);
}

// ── Drop shadow ──────────────────────────────────────────────────────────────
//
// Builds a soft, offset, blurred black silhouette of a cutout's alpha
// channel, so the pasted product reads as sitting on the surface rather
// than floating/stuck on top of it. Paired with the contact shadow above —
// this one adds close detail/direction, the ellipse does the actual
// grounding work.
async function makeDropShadow(
  cutoutBuffer,
  { offsetX = 10, offsetY = 16, blur = 14, opacity = 0.45 } = {},
) {
  const silhouette = await sharp(cutoutBuffer)
    .ensureAlpha()
    .extractChannel("alpha")
    .png()
    .toBuffer();

  const meta = await sharp(cutoutBuffer).metadata();

  // Tint the alpha-only silhouette black, apply opacity + blur.
  const shadow = await sharp({
    create: {
      width: meta.width,
      height: meta.height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: silhouette, blend: "dest-in" }])
    .ensureAlpha()
    .blur(blur)
    .png()
    .toBuffer();

  // Reduce opacity by scaling the alpha channel.
  const { data, info } = await sharp(shadow)
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    data[i + 3] = Math.round(data[i + 3] * opacity);
  }
  const finalShadow = await sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .png()
    .toBuffer();

  return {
    buffer: finalShadow,
    offsetX,
    offsetY,
    width: meta.width,
    height: meta.height,
  };
}

// ── Text block (SVG + sharp, not Flux) ──────────────────────────────────────
//
// Real typography, fully reliable (unlike asking a diffusion model to
// render legible text), styled like an actual ad rather than a caption
// slapped on a photo: a small letter-spaced EYEBROW line, a big bold
// HEADLINE (auto-wraps to two lines), and an optional pill-shaped BADGE —
// the same three-tier structure a graphic designer uses for a promo
// creative (kicker / big statement / call-to-action tag). All three are
// optional and independent; pass only what you have.
//
// LAYOUT VARIETY: a single fixed composition (text always top-stacked,
// centered, same font sizes) is what made two different campaigns with
// different wording still look like "the same ad" — confirmed from two
// real generated images (AVX Golf Balls / "New Year — Play One Length")
// that only differed in backdrop color and words, not composition. A real
// designer varies the LAYOUT, not just the copy: where the eyebrow/badge
// sit, which way text aligns, whether there's a solid color block. See
// LAYOUT_STYLES below — one gets picked per image, independent of which
// WORDING_PATTERN the content-gen step picked, so the two axes of variety
// (words, composition) multiply instead of only one of them varying.
function escapeXml(str) {
  return (
    String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      // Numeric reference, not the named &apos; entity — confirmed from an
      // actual crash: librsvg (what sharp uses to rasterize this SVG) threw
      // "Entity 'APOS' not defined" on a headline containing an apostrophe
      // ("Members' Christmas Combo"). &apos; is valid XML but librsvg doesn't
      // reliably resolve it here; &#39; is a plain numeric character
      // reference, so there's no named-entity table lookup to fail on.
      .replace(/'/g, "&#39;")
  );
}

// Greedy paragraph-style wrap: fills each line with as many words as fit
// within maxChars, breaking to a new line only when the next word would
// overflow it. Never splits a word.
function greedyWrap(words, maxChars) {
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Picks a headline font size AND its line-wrap together, instead of the
// earlier version which fixed the font size first and only then wrapped —
// which meant a genuinely long headline (more words than the "keep it to
// ~6 words" guidance asks for, but staff can type whatever they want in
// the editable-wording box) would wrap to 2 lines that were individually
// still wider than the 1024px canvas and ran off the edge (caught by a
// stress-test case: "The Complete Winter Golf Essentials Bundle" rendered
// with its second line clipped at the frame edge). This instead tries
// progressively smaller font sizes until it finds one where the wrapped
// lines actually fit inside the canvas width, falling back to the smallest
// usable size (and up to 3 lines) for anything longer still, so no input
// length can overflow the frame.
const HEADLINE_CHAR_WIDTH_RATIO = 0.62; // approx advance width for this bold face
function layoutHeadline(text, width) {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return { lines: [], fontSize: 0 };

  const maxFontSize = Math.round(width * 0.088);
  const minFontSize = Math.round(width * 0.042);
  const safeWidth = width * 0.9;
  const step = Math.max(1, Math.round((maxFontSize - minFontSize) / 14));

  let best = null;
  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= step) {
    const maxChars = Math.max(
      4,
      Math.floor(safeWidth / (fontSize * HEADLINE_CHAR_WIDTH_RATIO)),
    );
    const lines = greedyWrap(words, maxChars);
    const longestLine = Math.max(...lines.map((l) => l.length));
    const fits =
      longestLine * fontSize * HEADLINE_CHAR_WIDTH_RATIO <= safeWidth;
    best = { lines, fontSize };
    if (lines.length <= 2 && fits) break;
  }

  // Final safety net: even at the smallest font size tried, scale down
  // further if the longest line would still overflow (an extremely long
  // single word, or a very long headline staff typed by hand).
  const longestLine = Math.max(...best.lines.map((l) => l.length));
  const overflowRatio =
    (longestLine * best.fontSize * HEADLINE_CHAR_WIDTH_RATIO) / safeWidth;
  if (overflowRatio > 1) {
    best.fontSize = Math.max(
      Math.round(minFontSize * 0.75),
      Math.round(best.fontSize / overflowRatio),
    );
  }

  return best;
}

// Shared SVG <defs> — font-face rules plus the two gradients every layout
// draws from (scrim direction is supplied per-layout via a second stop
// list, gold is always the same brand accent).
function buildDefsBlock(scrimStops) {
  return `
    <defs>
      ${FONT_FACE_CSS}
      <linearGradient id="scrim" x1="0" y1="${scrimStops.y1}" x2="0" y2="${scrimStops.y2}">
        <stop offset="0%" stop-color="#000000" stop-opacity="0.72" />
        <stop offset="60%" stop-color="#000000" stop-opacity="0.38" />
        <stop offset="100%" stop-color="#000000" stop-opacity="0" />
      </linearGradient>
      <linearGradient id="gold" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#c79a3f" stop-opacity="1" />
        <stop offset="100%" stop-color="#e8c766" stop-opacity="1" />
      </linearGradient>
    </defs>
  `;
}

// Builds the <text> element for the headline's wrapped lines. Shared by
// every layout so the uppercase-then-escape order fix (see escapeXml's own
// comment — reversing this order was a real production crash, twice) only
// has to be correct in ONE place, not re-derived per layout.
function headlineTextEl({ lines, startY, lineHeight, fontSize, x, anchor }) {
  const tspans = lines
    .map(
      (line, i) =>
        `<tspan x="${x}" y="${startY + i * lineHeight}">${escapeXml(line.toUpperCase())}</tspan>`,
    )
    .join("");
  return `<text
      font-family="${HEADLINE_FONT_FAMILY}"
      font-weight="800"
      font-size="${fontSize}"
      fill="#ffffff"
      text-anchor="${anchor}"
      dominant-baseline="middle"
      letter-spacing="${Math.round(fontSize * 0.01)}"
      style="paint-order: stroke; stroke: rgba(0,0,0,0.4); stroke-width: ${Math.max(1, Math.round(fontSize * 0.025))}px;"
    >${tspans}</text>`;
}

function eyebrowTextEl({ text, x, y, fontSize, anchor, fill = "#e8c766" }) {
  return `<text
      x="${x}"
      y="${y}"
      font-family="${EYEBROW_FONT_FAMILY}"
      font-weight="600"
      font-size="${fontSize}"
      fill="${fill}"
      text-anchor="${anchor}"
      dominant-baseline="middle"
      letter-spacing="${Math.round(fontSize * 0.32)}"
    >${escapeXml(text.toUpperCase())}</text>`;
}

function badgePillEl({ text, cx, y, fontSize, fillText = "#1a1a1a" }) {
  const safe = escapeXml(text.toUpperCase());
  const textWidth = safe.length * fontSize * 0.62;
  const paddingX = Math.round(fontSize * 1.1);
  const width = Math.round(textWidth + paddingX * 2);
  const height = Math.round(fontSize * 2.1);
  const x = Math.round(cx - width / 2);
  return {
    width,
    height,
    svg: `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${Math.round(height / 2)}" fill="url(#gold)" />
      <text x="${cx}" y="${y + height / 2 + 1}" font-family="${EYEBROW_FONT_FAMILY}" font-weight="600" font-size="${fontSize}" fill="${fillText}" text-anchor="middle" dominant-baseline="middle" letter-spacing="${Math.round(fontSize * 0.14)}">${safe}</text>`,
  };
}

// A thin gold accent rule — used by any layout as the "there's a headline
// but nothing else" fallback so a sparse wording pattern (see
// WORDING_PATTERNS — "minimal" picks headline-only about 1 in 6 times)
// never renders as plain undecorated text. Confirmed too bare from an
// actual generated image before this existed.
function accentRuleEl({ cx, y, width = 90 }) {
  return `<rect x="${Math.round(cx - width / 2)}" y="${y}" width="${width}" height="4" rx="2" fill="url(#gold)" />`;
}

// ── Layout styles ────────────────────────────────────────────────────────────
//
// Four distinct compositions, each a legitimate ad-layout pattern a graphic
// designer would reach for. One is picked per image (see composeImage), so
// two campaigns with similar wording still read as different pieces of
// design rather than the same template with new words dropped in.
const LAYOUT_STYLES = [
  "top-stack",
  "bottom-caption",
  "corner-tag",
  "center-band",
];

// A) top-stack — the original layout. Eyebrow/headline/badge centered,
// stacked at the top, dark-from-top scrim. Classic poster convention:
// kicker, statement, call-to-action tag, product as hero below.
function layoutTopStack({
  eyebrow,
  headline,
  badgeText,
  hasEyebrow,
  hasHeadline,
  hasBadge,
  headlineLines,
  headlineFontSize,
  lineHeight,
  width,
  height,
}) {
  const eyebrowFontSize = Math.round(width * 0.032);
  const eyebrowY = Math.round(height * 0.1);
  const headlineStartY = hasEyebrow
    ? eyebrowY + Math.round(height * 0.075)
    : Math.round(height * 0.12);
  const headlineEndY = headlineStartY + headlineLines.length * lineHeight;
  const badgeY = headlineEndY + Math.round(height * 0.045);
  const badgeFontSize = Math.round(width * 0.03);
  const hasAccentRule = hasHeadline && !hasBadge;
  const ruleY = headlineEndY + Math.round(height * 0.03);

  const badge = hasBadge
    ? badgePillEl({
        text: badgeText,
        cx: width / 2,
        y: badgeY,
        fontSize: badgeFontSize,
      })
    : null;
  const scrimBottom = Math.round(
    (hasBadge
      ? badgeY + badge.height
      : hasAccentRule
        ? ruleY + 6
        : headlineEndY) +
      height * 0.04,
  );

  const elements = [];
  if (hasEyebrow)
    elements.push(
      eyebrowTextEl({
        text: eyebrow,
        x: "50%",
        y: eyebrowY,
        fontSize: eyebrowFontSize,
        anchor: "middle",
      }),
    );
  if (hasHeadline)
    elements.push(
      headlineTextEl({
        lines: headlineLines,
        startY: headlineStartY,
        lineHeight,
        fontSize: headlineFontSize,
        x: "50%",
        anchor: "middle",
      }),
    );
  if (hasBadge) elements.push(badge.svg);
  if (hasAccentRule) elements.push(accentRuleEl({ cx: width / 2, y: ruleY }));

  return {
    scrim: { y1: "0", y2: "1", x: 0, y: 0, width, height: scrimBottom },
    elements,
  };
}

// B) bottom-caption — flips the whole block to the bottom edge, scrim
// fading up from the bottom instead of down from the top. Product gets the
// full upper frame as open "stage" space, caption reads like a photo
// credit line / lower-third, a common move in lifestyle/editorial ads.
function layoutBottomCaption({
  eyebrow,
  headline,
  badgeText,
  hasEyebrow,
  hasHeadline,
  hasBadge,
  headlineLines,
  headlineFontSize,
  lineHeight,
  width,
  height,
}) {
  const eyebrowFontSize = Math.round(width * 0.03);
  const badgeFontSize = Math.round(width * 0.028);
  const blockBottom = Math.round(height * 0.9);

  let cursorY = blockBottom;
  let badge = null;
  let badgeY = null;
  if (hasBadge) {
    // badgePillEl needs its own height to compute badgeY, but its height
    // only depends on text/fontSize, not y — so a throwaway call at y=0
    // gets us the height, then the real call places it correctly.
    const badgeHeight = badgePillEl({
      text: badgeText,
      cx: width / 2,
      y: 0,
      fontSize: badgeFontSize,
    }).height;
    badgeY = cursorY - badgeHeight;
    badge = badgePillEl({
      text: badgeText,
      cx: width / 2,
      y: badgeY,
      fontSize: badgeFontSize,
    });
    cursorY = badgeY - Math.round(height * 0.04);
  }

  let headlineStartY = null;
  const headlineBlockHeight = headlineLines.length * lineHeight;
  const hasAccentRule = hasHeadline && !hasBadge;
  let ruleY = null;
  if (hasHeadline) {
    const headlineEndY = cursorY;
    headlineStartY = headlineEndY - headlineBlockHeight + lineHeight;
    cursorY = headlineStartY - Math.round(height * 0.07);
    if (hasAccentRule) {
      ruleY = headlineEndY + Math.round(height * 0.025);
      cursorY = headlineStartY - Math.round(height * 0.07);
    }
  }

  let eyebrowY = null;
  if (hasEyebrow) {
    eyebrowY = cursorY;
  }

  const topOfBlock = hasEyebrow
    ? eyebrowY
    : hasHeadline
      ? headlineStartY
      : badgeY;
  const scrimTop = Math.round((topOfBlock ?? blockBottom) - height * 0.06);

  const elements = [];
  if (hasEyebrow)
    elements.push(
      eyebrowTextEl({
        text: eyebrow,
        x: "50%",
        y: eyebrowY,
        fontSize: eyebrowFontSize,
        anchor: "middle",
      }),
    );
  if (hasHeadline)
    elements.push(
      headlineTextEl({
        lines: headlineLines,
        startY: headlineStartY,
        lineHeight,
        fontSize: headlineFontSize,
        x: "50%",
        anchor: "middle",
      }),
    );
  if (hasBadge) elements.push(badge.svg);
  if (hasAccentRule) elements.push(accentRuleEl({ cx: width / 2, y: ruleY }));

  return {
    scrim: {
      y1: "1",
      y2: "0",
      x: 0,
      y: scrimTop,
      width,
      height: height - scrimTop,
    },
    elements,
  };
}

// C) corner-tag — left-aligned kicker + headline (not centered — a
// magazine-cover convention), badge sits as a small standalone tag in the
// opposite top corner rather than stacked underneath. Reads more "editorial
// layout," visually distinct from the centered-poster feel of top-stack.
function layoutCornerTag({
  eyebrow,
  headline,
  badgeText,
  hasEyebrow,
  hasHeadline,
  hasBadge,
  headlineLines,
  headlineFontSize,
  lineHeight,
  width,
  height,
}) {
  const leftX = Math.round(width * 0.08);
  const eyebrowFontSize = Math.round(width * 0.03);
  const eyebrowY = Math.round(height * 0.095);
  const headlineStartY = hasEyebrow
    ? eyebrowY + Math.round(height * 0.07)
    : Math.round(height * 0.11);
  const headlineEndY = headlineStartY + headlineLines.length * lineHeight;
  const badgeFontSize = Math.round(width * 0.026);
  const hasAccentRule = hasHeadline && !hasBadge;
  const ruleY = headlineEndY + Math.round(height * 0.03);

  // Badge sits BELOW the text block, left-aligned (not a fixed top-right
  // corner position) — a fixed corner Y used to collide with the headline
  // whenever there was no eyebrow to push the headline down first (the
  // headline starts higher with no eyebrow, confirmed from an actual
  // generated image where "DIWALI OFFER" landed directly on top of "TWO
  // STAND BAGS"). Stacking it under the headline, the same way top-stack
  // does, makes the vertical position always correct regardless of what
  // else is present — the left-alignment (vs. top-stack's centered text)
  // is what keeps this a visually distinct layout.
  const badgeY = headlineEndY + Math.round(height * 0.04);
  let badge = null;
  if (hasBadge) {
    // badgePillEl centers its pill on `cx`; probe once at cx=0 just to read
    // the pill's own width (independent of x/y), then place it flush left.
    const probeWidth = badgePillEl({
      text: badgeText,
      cx: 0,
      y: 0,
      fontSize: badgeFontSize,
    }).width;
    const cx = leftX + probeWidth / 2;
    badge = badgePillEl({
      text: badgeText,
      cx,
      y: badgeY,
      fontSize: badgeFontSize,
    });
  }
  const scrimBottom = Math.round(
    (hasBadge
      ? badgeY + badge.height
      : hasAccentRule
        ? ruleY + 6
        : headlineEndY) +
      height * 0.04,
  );

  const elements = [];
  if (hasEyebrow)
    elements.push(
      eyebrowTextEl({
        text: eyebrow,
        x: leftX,
        y: eyebrowY,
        fontSize: eyebrowFontSize,
        anchor: "start",
      }),
    );
  if (hasHeadline)
    elements.push(
      headlineTextEl({
        lines: headlineLines,
        startY: headlineStartY,
        lineHeight,
        fontSize: headlineFontSize,
        x: leftX,
        anchor: "start",
      }),
    );
  if (hasBadge) elements.push(badge.svg);
  if (hasAccentRule)
    elements.push(
      `<rect x="${leftX}" y="${ruleY}" width="90" height="4" rx="2" fill="url(#gold)" />`,
    );

  return {
    scrim: { y1: "0", y2: "1", x: 0, y: 0, width, height: scrimBottom },
    elements,
  };
}

// D) center-band — a solid gold banner carrying the eyebrow/badge copy as
// dark text on gold (the strongest-contrast, most "promo poster" move of
// the four), headline in white above it. Falls back to a top-stack-style
// accent rule when there's no eyebrow or badge to put on a band at all.
function layoutCenterBand({
  eyebrow,
  headline,
  badgeText,
  hasEyebrow,
  hasHeadline,
  hasBadge,
  headlineLines,
  headlineFontSize,
  lineHeight,
  width,
  height,
}) {
  const headlineStartY = Math.round(height * 0.13);
  const headlineEndY = headlineStartY + headlineLines.length * lineHeight;
  const bandText = hasBadge ? badgeText : hasEyebrow ? eyebrow : null;
  const hasBand = Boolean(bandText && bandText.trim());
  const hasAccentRule = hasHeadline && !hasBand;

  const elements = [];
  let scrimBottom;

  if (hasHeadline) {
    elements.push(
      headlineTextEl({
        lines: headlineLines,
        startY: headlineStartY,
        lineHeight,
        fontSize: headlineFontSize,
        x: "50%",
        anchor: "middle",
      }),
    );
  }

  if (hasBand) {
    const bandY = headlineEndY + Math.round(height * 0.035);
    const bandHeight = Math.round(height * 0.085);
    const bandFontSize = Math.round(width * 0.032);
    const safe = escapeXml(bandText.toUpperCase());
    elements.push(
      `<rect x="0" y="${bandY}" width="${width}" height="${bandHeight}" fill="url(#gold)" />`,
    );
    elements.push(
      `<text x="50%" y="${bandY + bandHeight / 2 + 1}" font-family="${EYEBROW_FONT_FAMILY}" font-weight="600" font-size="${bandFontSize}" fill="#1a1a1a" text-anchor="middle" dominant-baseline="middle" letter-spacing="${Math.round(bandFontSize * 0.2)}">${safe}</text>`,
    );
    scrimBottom = bandY + bandHeight + Math.round(height * 0.03);
  } else if (hasAccentRule) {
    const ruleY = headlineEndY + Math.round(height * 0.03);
    elements.push(accentRuleEl({ cx: width / 2, y: ruleY }));
    scrimBottom = ruleY + Math.round(height * 0.04);
  } else {
    scrimBottom = headlineEndY + Math.round(height * 0.04);
  }

  return {
    scrim: { y1: "0", y2: "1", x: 0, y: 0, width, height: scrimBottom },
    elements,
  };
}

const LAYOUT_BUILDERS = {
  "top-stack": layoutTopStack,
  "bottom-caption": layoutBottomCaption,
  "corner-tag": layoutCornerTag,
  "center-band": layoutCenterBand,
};

// Returns { svg: Buffer, band: {top, bottom} } — band is the vertical strip
// of the canvas this layout's text actually occupies (the scrim's own
// footprint, which every layout already computes to keep the right text
// legible). composeImage uses this to keep the PRODUCT out of that strip —
// without it, a layout whose text block runs long (a 2-line headline plus a
// badge in top-stack, or the whole block in bottom-caption) visibly
// overlapped the product photo, confirmed from an actual rendered test
// image where the badge pill sat half on top of the product. Returns null
// (no band restriction) when there's no text at all.
function buildTextBlockSvg(
  { eyebrow = null, headline = null, badgeText = null },
  { width = CANVAS_SIZE, height = CANVAS_SIZE, layoutStyle = "top-stack" } = {},
) {
  const hasEyebrow = Boolean(eyebrow && eyebrow.trim());
  const hasHeadline = Boolean(headline && headline.trim());
  const hasBadge = Boolean(badgeText && badgeText.trim());

  if (!hasEyebrow && !hasHeadline && !hasBadge) return null;

  const headlineLayout = hasHeadline
    ? layoutHeadline(headline, width)
    : { lines: [], fontSize: 0 };
  const lineHeight = Math.round(headlineLayout.fontSize * 1.08);

  const builder = LAYOUT_BUILDERS[layoutStyle] || layoutTopStack;
  const { scrim, elements } = builder({
    eyebrow,
    headline,
    badgeText,
    hasEyebrow,
    hasHeadline,
    hasBadge,
    headlineLines: headlineLayout.lines,
    headlineFontSize: headlineLayout.fontSize,
    lineHeight,
    width,
    height,
  });

  const svg = Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      ${buildDefsBlock(scrim)}
      <rect x="${scrim.x}" y="${scrim.y}" width="${scrim.width}" height="${scrim.height}" fill="url(#scrim)" />
      ${elements.join("\n")}
    </svg>
  `);

  return { svg, band: { top: scrim.y, bottom: scrim.y + scrim.height } };
}

// ── Occasion decoration ──────────────────────────────────────────────────────
//
// The text layouts above fix the "every image looks the same" complaint.
// This addresses the separate "no theme elements" complaint: the Flux
// backdrop prompt deliberately asks for a clean, uncluttered scene (see the
// prompt built in imageGenerationService — that constraint exists to stop
// the diffusion model from drawing oversized seasonal props INTO the scene,
// which is what caused the earlier mud-lamp-for-Christmas bug), so festive
// backdrops come back visually sparse. Rather than loosening that prompt
// and risking the same bug again, occasion decoration is drawn here, in
// code, the same deterministic way the gold accent rule is — small,
// theme-colored accents scattered across the FULL canvas. They're safe to
// scatter freely (including over where the product will sit) because this
// layer composites BEFORE the product cutouts in composeImage, so the
// product always draws on top and nothing ever gets obscured.
function detectOccasionTheme(...texts) {
  const combined = texts.filter(Boolean).join(" ").toLowerCase();
  if (/diwali|deepavali/.test(combined)) return "diwali";
  if (/christmas|xmas/.test(combined)) return "christmas";
  if (/new year|new yr/.test(combined)) return "newyear";
  if (/republic day|independence day/.test(combined)) return "tricolor";
  return null;
}

function scatterShapes(count, shapeFn) {
  let out = "";
  for (let i = 0; i < count; i++) out += shapeFn(i);
  return out;
}

function buildDecorationSvg(themeKey, { width, height }) {
  if (!themeKey) return null;

  let shapes = "";
  if (themeKey === "newyear") {
    // Gold/cream confetti: small rotated rects + a few tiny dots, scattered
    // widely — the classic "it's a celebration" visual shorthand.
    shapes += scatterShapes(12, () => {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const size = 6 + Math.random() * 10;
      const rot = Math.round(Math.random() * 360);
      const color = Math.random() > 0.5 ? "#e8c766" : "#fff3d6";
      return `<rect x="${x}" y="${y}" width="${size}" height="${size * 0.4}" fill="${color}" opacity="${(0.35 + Math.random() * 0.3).toFixed(2)}" transform="rotate(${rot} ${x} ${y})" />`;
    });
    shapes += scatterShapes(8, () => {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const r = 2 + Math.random() * 3;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="${(0.3 + Math.random() * 0.3).toFixed(2)}" />`;
    });
  } else if (themeKey === "diwali") {
    // Warm glowing dots (diya-light shorthand) — radial-gradient glows
    // rather than flat dots so they read as light, not confetti.
    shapes += `<defs><radialGradient id="diyaGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffb347" stop-opacity="0.9" />
        <stop offset="100%" stop-color="#ffb347" stop-opacity="0" />
      </radialGradient></defs>`;
    shapes += scatterShapes(9, () => {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const r = 10 + Math.random() * 14;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="url(#diyaGlow)" />`;
    });
    shapes += scatterShapes(10, () => {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const r = 1.5 + Math.random() * 2.5;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffd27d" opacity="${(0.5 + Math.random() * 0.3).toFixed(2)}" />`;
    });
  } else if (themeKey === "christmas") {
    // Soft white "snow" dots plus a couple of small red/green accents.
    shapes += scatterShapes(14, () => {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const r = 2 + Math.random() * 3.5;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="#ffffff" opacity="${(0.35 + Math.random() * 0.35).toFixed(2)}" />`;
    });
    shapes += scatterShapes(4, () => {
      const x = Math.random() * width;
      const y = Math.random() * height;
      const r = 3 + Math.random() * 3;
      const color = Math.random() > 0.5 ? "#c0392b" : "#2e7d4f";
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}" opacity="${(0.4 + Math.random() * 0.25).toFixed(2)}" />`;
    });
  } else if (themeKey === "tricolor") {
    // A thin saffron/white/green stripe along the very top edge — subtle,
    // doesn't compete with any layout's text block underneath it.
    const stripeH = Math.round(height * 0.012);
    shapes += `<rect x="0" y="0" width="${width}" height="${stripeH}" fill="#FF9933" opacity="0.85" />`;
    shapes += `<rect x="0" y="${stripeH}" width="${width}" height="${stripeH}" fill="#FFFFFF" opacity="0.85" />`;
    shapes += `<rect x="0" y="${stripeH * 2}" width="${width}" height="${stripeH}" fill="#138808" opacity="0.85" />`;
  }

  if (!shapes) return null;
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${shapes}</svg>`,
  );
}

// ── Product layout ───────────────────────────────────────────────────────────
//
// Lays out up to 5 cutouts in a simple fanned row, sized and centered
// within whatever vertical ZONE is actually free of text — not a fixed
// position. With four different text layouts now possible (top-stack,
// corner-tag and center-band occupy the TOP of the frame; bottom-caption
// occupies the BOTTOM), a fixed "always lower 2/3" assumption put the
// product directly under a top-stack badge and directly under
// bottom-caption's whole text block — both confirmed as real overlaps in
// rendered test output. `zone` is the {top, bottom} band computeImage
// measured from the text block (or the full canvas when there's no text),
// and products are sized/centered to fit inside it with a margin.
function computeLayout(
  count,
  canvasSize = CANVAS_SIZE,
  zone = { top: 0, bottom: canvasSize },
) {
  const zoneHeight = zone.bottom - zone.top;
  const ratio = count <= 2 ? 0.74 : count === 3 ? 0.62 : 0.52;
  const targetHeight = Math.min(
    Math.round(zoneHeight * ratio),
    Math.round(canvasSize * 0.62), // cap so a very generous zone doesn't make the product oversized
  );
  const rowY = Math.round(zone.top + zoneHeight / 2);
  // For 1-2 products, divide the canvas into exactly `count` columns
  // (canvasSize/count) instead of count+1 — the +1 scheme reserves a
  // phantom extra column's worth of margin, which for 2 products meant
  // each one only got a 1/3-canvas-wide column even though nothing else
  // was competing for the other third. Confirmed from an actual generated
  // image where two stand bags both looked undersized. 3+ products keep
  // the +1 scheme — that's genuinely needed there so the outermost items
  // in a wider fan don't crowd the frame edges.
  const spacing =
    count <= 2
      ? Math.round(canvasSize / count)
      : Math.round(canvasSize / (count + 1));
  return { targetHeight, rowY, spacing };
}

// The margin kept between the text block's band and the product zone, so
// products sit clearly clear of the scrim rather than right at its edge.
const TEXT_PRODUCT_MARGIN = Math.round(CANVAS_SIZE * 0.03);

// Turns a text block's band into the opposite, free vertical zone for
// products. A band touching the very top (top===0) means the text occupies
// the top of the frame, so products get everything below it; a band
// touching the very bottom means the reverse (bottom-caption layout).
function computeProductZone(band, canvasSize = CANVAS_SIZE) {
  if (!band) return { top: 0, bottom: canvasSize };
  if (band.top <= 1) {
    return {
      top: Math.min(canvasSize * 0.85, band.bottom + TEXT_PRODUCT_MARGIN),
      bottom: canvasSize,
    };
  }
  return {
    top: 0,
    bottom: Math.max(canvasSize * 0.15, band.top - TEXT_PRODUCT_MARGIN),
  };
}

/**
 * composeImage
 *
 * @param {object} params
 * @param {Buffer} params.backdropBuffer       - the AI-generated backdrop (any size)
 * @param {Array<{title:string, buffer:Buffer}>} params.productCutouts - already background-removed PNGs
 * @param {string|null} [params.headline]      - optional big statement line (auto-wraps to 2 lines)
 * @param {string|null} [params.eyebrow]       - optional small kicker line above the headline
 * @param {string|null} [params.badgeText]     - optional short pill/tag below the headline (e.g. "FLASH SALE")
 * @returns {Promise<Buffer>} final JPEG buffer, 1024x1024
 *
 * NOTE: layoutStyle (which of LAYOUT_STYLES gets used) and occasion
 * decoration are picked randomly INSIDE this function, not passed in —
 * every call to composeImage gets a fresh composition. This includes
 * recomposeCampaignImage (the cheap wording-only edit path in
 * imageGenerationService.js): editing the eyebrow/headline/badge text on an
 * already-generated image also rerolls which layout/decoration it uses.
 * That's a deliberate trade-off, not an oversight — persisting the exact
 * original layout choice across edits would mean wiring a new field through
 * imageGenerationService, broadcastCampaignController, the frontend API
 * call, and InsightsWidget's saved state (the same shape of change that was
 * done for backdropUrl persistence). Given a layout reroll on text-edit is
 * harmless — if anything it gives staff a free "try a different look" for
 * nothing — this was judged not worth that wiring cost right now. If a
 * campaign's layout needs to stay fixed across wording edits later, add a
 * `layoutStyle` param here (default to random when omitted) and thread it
 * through the same four files the same way backdropUrl was threaded.
 */
async function composeImage({
  backdropBuffer,
  productCutouts = [],
  headline = null,
  eyebrow = null,
  badgeText = null,
  // True when the BACKDROP ITSELF was already asked (via its Flux prompt)
  // to include occasion decoration — diyas, marigolds, fairy lights, snow,
  // etc. The content-generation prompt (insightsAgentTools.js) writes rich,
  // occasion-specific backdropHint text now, which means Flux is often
  // already drawing the festive decoration directly into the scene. Without
  // this flag, the code-level decoration layer below (added for the
  // OPPOSITE problem — a backdrop that came back too bare) would stack on
  // top of decoration Flux already drew, reading as cluttered rather than
  // premium. Confirmed from an actual generated image whose prompt asked
  // for "brass diyas... marigold petals... a fairy light string" and which
  // also got the code-level warm-glow-dot layer on top of that.
  skipDecoration = false,
}) {
  const backdrop = await sharp(backdropBuffer)
    .resize(CANVAS_SIZE, CANVAS_SIZE, { fit: "cover" })
    .toBuffer();

  const composites = [];

  // Pick one layout style per image (see LAYOUT_STYLES) — this is what
  // actually varies the COMPOSITION, not just the words, between campaigns.
  const layoutStyle =
    LAYOUT_STYLES[Math.floor(Math.random() * LAYOUT_STYLES.length)];

  // Text geometry is computed BEFORE product placement (even though it
  // composites LAST, on top) specifically so the product can be sized and
  // centered to avoid the text block's band — see computeProductZone's own
  // comment for why a fixed product position doesn't work once more than
  // one layout exists.
  const textBlock = buildTextBlockSvg(
    { eyebrow, headline, badgeText },
    { layoutStyle },
  );
  const productZone = computeProductZone(textBlock ? textBlock.band : null);

  // Occasion decoration is drawn FIRST, right after the backdrop, so the
  // product cutouts (added next) and the text block (added last) both
  // composite on top of it — decoration can never obscure either one.
  const occasionTheme = skipDecoration
    ? null
    : detectOccasionTheme(eyebrow, headline, badgeText);
  const decoration = buildDecorationSvg(occasionTheme, {
    width: CANVAS_SIZE,
    height: CANVAS_SIZE,
  });
  if (decoration) {
    composites.push({ input: decoration, left: 0, top: 0 });
  }

  if (productCutouts.length > 0) {
    const { targetHeight, rowY, spacing } = computeLayout(
      productCutouts.length,
      CANVAS_SIZE,
      productZone,
    );

    // Real catalog photos vary wildly in aspect ratio — a wide/landscape
    // product shot (or one whose EXIF orientation wasn't accounted for)
    // used to compute targetWidth from height alone and could come out
    // wider than the whole canvas, which made sharp's composite() throw
    // "Image to composite must have same dimensions or smaller". Capping
    // the resize bounding box to a safe max width — and then reading back
    // the ACTUAL output dimensions sharp picked, rather than assuming the
    // box we asked for is what we got — guarantees every cutout and its
    // shadow fit inside the canvas regardless of the source photo's shape.
    const maxItemWidth = Math.min(
      Math.round(spacing * 0.9),
      Math.round(CANVAS_SIZE * 0.85),
    );

    for (let i = 0; i < productCutouts.length; i++) {
      const { buffer } = productCutouts[i];

      const { data: resizedData, info: resizedInfo } = await sharp(buffer)
        .rotate() // auto-orient by EXIF — see removeWhiteBackground for why
        .resize(maxItemWidth, targetHeight, { fit: "inside" })
        .png()
        .toBuffer({ resolveWithObject: true });
      const resized = resizedData;
      const actualWidth = resizedInfo.width;
      const actualHeight = resizedInfo.height;

      // Matches computeLayout's column scheme: count<=2 divides the canvas
      // into exactly `count` columns (centers at the middle of each), 3+
      // keeps the old scheme (centers at spacing*(i+1), i.e. after a
      // leading margin column).
      const centerX =
        productCutouts.length <= 2
          ? Math.round(spacing * (i + 0.5))
          : spacing * (i + 1);
      const left = Math.round(centerX - actualWidth / 2);
      const top = Math.round(rowY - actualHeight / 2);

      // Contact shadow first (furthest back), sized to the product's own
      // footprint so it doesn't bleed into neighboring products. Capped so
      // it can never exceed the canvas itself around centerX — sharp's
      // composite() throws "Image to composite must have same dimensions
      // or smaller" the moment ANY composited layer is wider than the base
      // canvas, and 1.3x a wide/square product cutout (confirmed from an
      // actual production error: a Pro V1 ball-box photo whose resized
      // width landed near the single-product cap of ~870px, ×1.3 = ~1131px
      // against a 1024px canvas) blew straight past that. The fan-layout
      // math upstream never constrained contact shadow width the way it
      // constrains the product itself, so this could only ever be caught
      // here, not avoided earlier.
      const maxContactShadowWidth =
        2 * Math.min(centerX, CANVAS_SIZE - centerX);
      const contactShadowWidth = Math.min(
        Math.round(actualWidth * 1.3),
        Math.max(maxContactShadowWidth, actualWidth), // never shrink below the product's own width
      );
      const contactShadowHeight = Math.round(actualHeight * 0.4);
      composites.push({
        input: buildContactShadowSvg(contactShadowWidth, contactShadowHeight),
        left: Math.round(centerX - contactShadowWidth / 2),
        top: top + actualHeight - Math.round(contactShadowHeight * 0.55),
      });

      const shadow = await makeDropShadow(resized);
      composites.push({
        input: shadow.buffer,
        left:
          left + shadow.offsetX - Math.round((shadow.width - actualWidth) / 2),
        top: top + shadow.offsetY,
      });
      composites.push({ input: resized, left, top });
    }
  }

  if (textBlock) {
    composites.push({ input: textBlock.svg, left: 0, top: 0 });
  }

  return sharp(backdrop).composite(composites).jpeg({ quality: 92 }).toBuffer();
}

module.exports = { removeWhiteBackground, composeImage };
