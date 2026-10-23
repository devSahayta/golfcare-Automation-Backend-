// src/services/productImageMatchService.js
//
// Path A of the campaign header-image flow: check whether a campaign is
// actually about one named, real product already in the catalog. If so,
// use its real photo (Product.imageUrls) instead of generating anything —
// same "never show a customer something unverified" principle already used
// for DynamicTemplate.imageUrl.
//
// Deterministic DB lookup only — no LLM involved in picking the match, so
// it can never hallucinate a product that doesn't exist.
//
// Shared by two callers:
//   - broadcastCampaignController.resolveProductImage (REST endpoint the
//     Insights widget calls to preview/approve a real photo)
//   - insightsAgentTools.check_product_photo (an agent tool, so the Insights
//     agent can check BEFORE generating anything and tell the staff member
//     directly — "I couldn't find that product" — rather than silently
//     falling back to an AI image without saying so)
// Kept as one function so the two can never drift apart or disagree.
//
// Returns one of:
//   { matched: false }                                   — no product name match
//   { matched: true, ambiguous: true, candidates: [...] } — 2+ products matched
//   { matched: true, ambiguous: false, product: {...} }   — exactly one confident match

const { prisma } = require("../lib/prisma");

function wordsOf(query) {
  return (query || "")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2);
}

// Splits a title into whole words (strips punctuation like the "-" in
// "Pro V1 Golf Balls - White"), lowercased.
function titleTokens(title) {
  return (title || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

// Crude singular/plural normalization so "bags" matches a title that says
// "Bag" and vice versa ("irons"/"iron", "balls"/"ball", "shoes"/"shoe").
// Only strips a trailing "s" on words long enough that this is safe
// (short words like "gas"/"is" are left alone).
function normalizeToken(word) {
  return word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word;
}

// ── Compound-word splitting ──────────────────────────────────────────────────
//
// Staff often write compound words with no space ("Weatherspann", "Superfast",
// "Regalstar") that in the catalog title appear as two separate words
// ("Weather Spann", "Super Fast"). Split a long query token into the two
// largest sub-words that both exist as title tokens across any product.
//
// Approach: for each split point in the word, check whether left and right
// halves (each ≥ 3 chars) are recognized title tokens (in the provided set).
// Returns an array of 1–2 tokens to use in place of the original word.
// Falls back to the original single token if no useful split is found.
//
function splitCompound(word, knownTokens) {
  if (word.length < 6) return [word]; // too short to usefully split
  for (let i = 3; i <= word.length - 3; i++) {
    const left = word.slice(0, i);
    const right = word.slice(i);
    const leftNorm = normalizeToken(left);
    const rightNorm = normalizeToken(right);
    if (knownTokens.has(leftNorm) && knownTokens.has(rightNorm)) {
      return [left, right];
    }
  }
  return [word];
}

// ── Partial/prefix matching ──────────────────────────────────────────────────
//
// Returns a match weight (0, 0.6, or 1.0) for how well a single query token
// matches any of the title token forms:
//   1.0 — exact match (after normalization)
//   0.6 — one is a prefix of the other (min length 4) — catches "Spann" vs
//          "Spann" (same) but also "weather" matching "weatherspann" if the
//          compound split didn't catch it.
//   0   — no match
//
function partialMatchWeight(queryNorm, titleForms) {
  if (titleForms.has(queryNorm)) return 1.0;
  // Prefix match — query is a prefix of a title token or vice versa
  if (queryNorm.length >= 4) {
    for (const tf of titleForms) {
      if (tf.length >= 4) {
        if (tf.startsWith(queryNorm) || queryNorm.startsWith(tf)) return 0.6;
      }
    }
  }
  return 0;
}

/**
 * matchProductImage
 *
 * Scores every active, photographed product in the catalog by how many
 * words of `query` it matches against TITLE tokens, using three layers:
 *
 *   1. Exact token match (after singular/plural normalization) — weight 1.0
 *   2. Compound-word split: if a query token like "Weatherspann" doesn't
 *      match directly, try splitting it into sub-words ("weather"+"spann")
 *      and score those sub-words independently — weight 1.0 each if found
 *   3. Prefix/substring match: if a query token is a prefix of a title token
 *      or vice versa (min length 4), count it as a partial match — weight 0.6
 *
 * This means "Callaway Weatherspann" correctly finds
 * "Women's Weather Spann Glove - Right..." because:
 *   - "callaway" matches "callaway" in the brand (exact, weight 1.0)
 *   - "weatherspann" splits into "weather" + "spann", both found (weight 2.0)
 *
 * Tags are intentionally excluded (loose/inconsistent; caused real false
 * positives in testing). Scores do NOT need to be integers — thresholds
 * are adjusted accordingly.
 *
 * @param {string} query - freeform text (e.g. a campaign name) to match
 * @param {object} [options]
 * @param {(msg: string) => void} [options.log] - optional logger, called
 *   with each diagnostic line (defaults to console.log)
 * @returns {Promise<{matched: boolean, ambiguous?: boolean, product?: object, candidates?: object[]}>}
 */
async function matchProductImage(query, { log = console.log } = {}) {
  const queryWordsLower = wordsOf(query).map((w) => w.toLowerCase());

  if (queryWordsLower.length === 0) {
    log(`[matchProductImage] no usable words -> matched: false`);
    return { matched: false };
  }

  // Full active, photographed catalog — no recency cap, so a real match can
  // never be silently pushed out by unrelated recently-synced items.
  const allProducts = await prisma.product.findMany({
    where: {
      status: "active",
      imageUrls: { isEmpty: false },
    },
    select: {
      id: true,
      title: true,
      vendor: true, // brand name — "TaylorMade", "Callaway", "Titleist" etc.
      productType: true, // category — "Balls", "Clubs", "Gloves" etc.
      tags: true, // array — ["BALLS","Titleist"] etc.
      imageUrls: true,
    },
  });

  log(
    `[matchProductImage] scoring "${query}" against ${allProducts.length} active/photographed product(s)`,
  );

  // ── Field weights ─────────────────────────────────────────────────────────
  //
  // When a query word matches a token from different fields, we take the BEST
  // (highest) weight across all fields — a word isn't double-counted for
  // appearing in both title and vendor.
  //
  //   title       1.0  — most specific; "Superfast" in title is the product name
  //   vendor      1.0  — brand name is equally authoritative ("TaylorMade balls"
  //                      → "taylormade" found in vendor, not in title TP5/TP5x)
  //   productType 0.8  — "balls", "clubs", "gloves" — useful category signal
  //   tags        0.7  — supplementary; often repeat title/vendor words
  //
  const FIELD_WEIGHT = {
    title: 1.0,
    vendor: 1.0,
    productType: 0.8,
    tag: 0.7,
  };

  // Build a global token set across ALL fields of ALL products — used by
  // splitCompound() to detect valid sub-words (e.g. "weatherspann" → "weather"+"spann").
  // Including vendor/tags here lets compound-brand-names split correctly too.
  const globalTokenForms = new Set();
  for (const p of allProducts) {
    for (const t of titleTokens(p.title))
      globalTokenForms.add(normalizeToken(t));
    for (const t of titleTokens(p.vendor))
      globalTokenForms.add(normalizeToken(t));
    for (const t of titleTokens(p.productType))
      globalTokenForms.add(normalizeToken(t));
    for (const tag of p.tags || []) {
      for (const t of titleTokens(tag)) globalTokenForms.add(normalizeToken(t));
    }
  }

  // Expand query words: each word may split into sub-words after compound splitting.
  const expandedQuery = queryWordsLower.map((word) => {
    const norm = normalizeToken(word);
    const parts = splitCompound(norm, globalTokenForms);
    return { original: word, effective: parts };
  });

  log(
    `[matchProductImage] expanded query: ${JSON.stringify(expandedQuery.map((e) => ({ original: e.original, effective: e.effective })))}`,
  );

  let bestScore = 0;
  const scored = allProducts.map((p) => {
    // Build per-field token sets for this product
    const fieldSets = {
      title: new Set(titleTokens(p.title).map(normalizeToken)),
      vendor: new Set(titleTokens(p.vendor).map(normalizeToken)),
      productType: new Set(titleTokens(p.productType).map(normalizeToken)),
      tag: new Set(
        (p.tags || []).flatMap((tag) => titleTokens(tag).map(normalizeToken)),
      ),
    };

    // Score each query word: for each effective part, find the best match weight
    // across ALL fields (vendor, title, productType, tags) and multiply by that
    // field's weight. Take best field per part to avoid double-counting.
    let score = 0;
    const matchedWords = [];
    for (const { original, effective } of expandedQuery) {
      let wordScore = 0;
      for (const part of effective) {
        const partNorm = normalizeToken(part);
        let bestPartScore = 0;
        for (const [field, tokenSet] of Object.entries(fieldSets)) {
          const matchW = partialMatchWeight(partNorm, tokenSet);
          if (matchW > 0) {
            const fieldScore = matchW * FIELD_WEIGHT[field];
            if (fieldScore > bestPartScore) bestPartScore = fieldScore;
          }
        }
        wordScore += bestPartScore;
      }
      if (wordScore > 0) {
        matchedWords.push(original);
        score += wordScore;
      }
    }

    if (score > bestScore) bestScore = score;

    // extraTokens: title words not matched — tiebreaker for precision.
    const titleTokenCount = titleTokens(p.title).length;
    const extraTokens = Math.max(0, titleTokenCount - matchedWords.length);
    return { product: p, score, matchedWords, extraTokens };
  });

  // Minimum required score: for a single-word query require ≥ 0.7 (a vendor-only
  // match like "taylormade" → vendor weight 1.0, so 0.7 is safely met).
  // For multi-word queries require ≥ 1.8 so at least ~2 tokens match.
  const minRequired = queryWordsLower.length >= 2 ? 1.8 : 0.7;

  if (bestScore < minRequired) {
    log(
      `[matchProductImage] best score ${bestScore.toFixed(2)} < required ${minRequired} -> matched: false`,
    );
    return { matched: false };
  }

  const tiedOnScore = scored.filter(
    (s) => Math.abs(s.score - bestScore) < 0.01,
  );

  // Tiebreaker: among products that scored equally, prefer the one(s) whose
  // title has the fewest OTHER words left over — the tighter, more precise match.
  const minExtra = Math.min(...tiedOnScore.map((s) => s.extraTokens));
  const topMatches = tiedOnScore
    .filter((s) => s.extraTokens === minExtra)
    .slice(0, 5);

  log(
    `[matchProductImage] bestScore=${bestScore.toFixed(2)} minExtra=${minExtra} topMatches=${JSON.stringify(
      topMatches.map((m) => ({
        title: m.product.title,
        matchedWords: m.matchedWords,
        score: m.score.toFixed(2),
        extraTokens: m.extraTokens,
      })),
    )}`,
  );

  const candidates = topMatches.map(({ product }) => ({
    id: product.id,
    title: product.title,
    productType: product.productType,
    imageUrls: product.imageUrls,
  }));

  if (candidates.length === 1) {
    log(
      `[matchProductImage] -> matched: true, ambiguous: false, product="${candidates[0].title}"`,
    );
    return { matched: true, ambiguous: false, product: candidates[0] };
  }

  log(
    `[matchProductImage] -> matched: true, ambiguous: true, ${candidates.length} candidates`,
  );
  // Multiple products tied for the best score — don't guess which one the
  // staff member meant. Let them pick.
  return { matched: true, ambiguous: true, candidates };
}

/**
 * getProductPhotosByTitles
 *
 * Looks up real photos for a list of EXACT catalog product titles — used by
 * both multi-product campaign image paths in imageGenerationService.js
 * (generateAIComposedCampaignImage, which passes these as reference images to
 * the AI, and generateRawProductCampaignImage, the no-AI path).
 * Unlike matchProductImage, this takes no fuzzy query text at all: by the
 * time this is called, the Insights agent has already confirmed each
 * product via check_product_photo (fuzzy matching happened then, once), so
 * this is a precise, deterministic lookup by the exact title that was
 * confirmed — it should never need to guess or score anything a second
 * time.
 *
 * Silently skips any title that no longer matches (e.g. the product was
 * archived between the agent's check and the image being generated) rather
 * than failing the whole request — the caller reports back which titles
 * came back with no photo, same "tell the staff member" principle used
 * everywhere else in this image pipeline.
 *
 * @param {string[]} titles - exact Product.title values to look up
 * @returns {Promise<{title: string, imageUrl: string, imageUrls: string[]}[]>}
 *   imageUrl is always imageUrls[0] (the default), kept alongside the full
 *   array so callers that only ever used one photo don't need to change —
 *   imageUrls is new, added so the RAW_PHOTO path (see
 *   generateRawProductCampaignImage) can let staff switch between all of a
 *   product's real catalog photos instead of only ever seeing the first.
 */
async function getProductPhotosByTitles(titles) {
  if (!Array.isArray(titles) || titles.length === 0) return [];

  const products = await prisma.product.findMany({
    where: {
      title: { in: titles },
      status: "active",
      imageUrls: { isEmpty: false },
    },
    select: { title: true, imageUrls: true },
  });

  return products
    .filter((p) => p.imageUrls.length > 0)
    .map((p) => ({
      title: p.title,
      imageUrl: p.imageUrls[0],
      imageUrls: p.imageUrls,
    }));
}

module.exports = { matchProductImage, getProductPhotosByTitles };
