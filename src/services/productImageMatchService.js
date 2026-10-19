// src/services/productImageMatchService.js
//
// Path A of the campaign header-image flow: before ever calling Replicate,
// check whether a campaign is actually about one named, real product
// already in the catalog. If so, use its real photo (Product.imageUrls)
// instead of generating anything — same "never show a customer something
// unverified" principle already used for DynamicTemplate.imageUrl.
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

// Splits a title into whole words only (strips punctuation like the "-" in
// "Pro V1 Golf Balls - White"), lowercased, for exact-token comparison.
// This is deliberately NOT substring matching — "v1" must equal a whole
// token, not just appear inside one, so it doesn't also match "v1x".
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

/**
 * matchProductImage
 *
 * Scores every active, photographed product in the catalog by how many
 * words of `query` it matches as whole TITLE tokens (not tags — tags in
 * this catalog are loose/inconsistent category or cross-reference labels;
 * matching on them once produced a real false positive, "Callaway kit
 * bags" wrongly resolving to an unrelated "Exia Boston Bag" purely because
 * of its tags). The title is the one field a human actually wrote to
 * describe the product, so it's the only trustworthy signal here.
 *
 * Generic marketing/occasion words that don't match anything ("Restock",
 * "Offer", "Diwali") simply contribute 0 to every score and are naturally
 * ignored — no hand-maintained stoplist needed.
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
  // never be silently pushed out by unrelated recently-synced items (an
  // earlier version capped this at 50, recency-ordered, and that hid the
  // actual best match behind 50 unrelated "White"-colored products).
  const allProducts = await prisma.product.findMany({
    where: {
      // Shopify's own status values come through lowercase ("active",
      // "archived", "draft") — matches the convention already used
      // elsewhere in this codebase (salesAgentTools.js, shopifyProductCreate.js).
      status: "active",
      imageUrls: { isEmpty: false },
    },
    select: {
      id: true,
      title: true,
      productType: true,
      imageUrls: true,
    },
  });

  log(
    `[matchProductImage] scoring "${query}" against ${allProducts.length} active/photographed product(s)`,
  );

  const queryForms = queryWordsLower.map((w) => normalizeToken(w));

  let bestScore = 0;
  const scored = allProducts.map((p) => {
    const tokens = titleTokens(p.title);
    const tokenForms = new Set(tokens.map((t) => normalizeToken(t)));
    const matchedWords = queryWordsLower.filter((word, i) =>
      tokenForms.has(queryForms[i]),
    );
    const score = matchedWords.length;
    if (score > bestScore) bestScore = score;
    // extraTokens = how many words in the TITLE weren't asked for — used as
    // a tiebreaker below so "Pro V1 Golf Balls - White" (every title word
    // matched) beats "Pro V1 Golf Balls - White (Special Number)" (2
    // unmatched extra words) when both match the same query words.
    const extraTokens = Math.max(0, tokens.length - matchedWords.length);
    return { product: p, score, matchedWords, extraTokens };
  });

  // Require at least 1 matched word, AND — if the query has more than one
  // word — at least 2, so a single coincidental word (e.g. only "White"
  // landing) doesn't masquerade as a confident match on its own.
  const minRequired = queryWordsLower.length >= 2 ? 2 : 1;

  if (bestScore < minRequired) {
    log(
      `[matchProductImage] best score ${bestScore} < required ${minRequired} -> matched: false`,
    );
    return { matched: false };
  }

  const tiedOnScore = scored.filter((s) => s.score === bestScore);

  // Tiebreaker: among products that matched the same number of query words,
  // prefer the one(s) whose title has the fewest OTHER words left over —
  // the tighter, more precise match.
  const minExtra = Math.min(...tiedOnScore.map((s) => s.extraTokens));
  const topMatches = tiedOnScore
    .filter((s) => s.extraTokens === minExtra)
    .slice(0, 5);

  log(
    `[matchProductImage] bestScore=${bestScore} minExtra=${minExtra} topMatches=${JSON.stringify(
      topMatches.map((m) => ({
        title: m.product.title,
        matchedWords: m.matchedWords,
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
 * the multi-product image-compositing feature (generateCompositeCampaignImage
 * in imageGenerationService.js). Unlike matchProductImage, this takes no
 * fuzzy query text at all: by the time this is called, the Insights agent
 * has already confirmed each product via check_product_photo (fuzzy
 * matching happened then, once), so this is a precise, deterministic
 * lookup by the exact title that was confirmed — it should never need to
 * guess or score anything a second time.
 *
 * Silently skips any title that no longer matches (e.g. the product was
 * archived between the agent's check and the image being generated) rather
 * than failing the whole request — the caller (generateCompositeCampaignImage)
 * reports back which titles came back with no photo, same "tell the staff
 * member" principle used everywhere else in this image pipeline.
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
