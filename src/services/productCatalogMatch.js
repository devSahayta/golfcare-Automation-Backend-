// src/services/productCatalogMatch.js
//
// "Is this product genuinely new?" matching logic, shared by the WhatsApp
// supplier agent's create_product_draft (supplierAgentTools.js) and the
// supplier check-in portal's own add-new-product endpoint
// (supplierPortalController.js) — extracted out rather than duplicated so
// both ways a supplier can submit a new product drive the exact same
// dedup/catalog-match decisions and can never drift apart. Same reasoning
// supplierCheckinService.js's own header comment gives for why IT was
// extracted out of supplierAgentTools.js.

const { prisma } = require("../lib/prisma");

const STOPWORDS = new Set([
  "the", "and", "for", "with", "size", "have", "any", "golf", "set", "of",
]);

function tokenize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

// create_product_draft's own-supplier dedup check — the same document/
// conversation staying in history can get reprocessed on a later turn (or,
// for the portal, a double-submit); this is the guard against creating a
// second Shopify product for something already pending review.
async function findExistingPendingDraft(supplierId, title) {
  const normalizedTitle = title.trim().toLowerCase();
  const pending = await prisma.productDraft.findMany({
    where: { supplierId, approvalStatus: "PENDING" },
    select: { approvalToken: true, rawPayload: true },
  });
  return (
    pending.find(
      (d) => (d.rawPayload?.title || "").trim().toLowerCase() === normalizedTitle,
    ) || null
  );
}

// create_product_draft's real-product-already-exists check — searches
// Golf Care's whole catalog (every Product/Variant, regardless of
// supplier), because a product being new to one supplier's own links says
// nothing about whether it's genuinely new to Golf Care.
//
// Deliberately conservative: only returns a match when both the product
// AND a specific variant are confidently identified. A wrong auto-link
// (applying a stock update to the wrong SKU) is worse than occasionally
// falling through to create a duplicate draft a human then has to notice
// and reject — asymmetric risk, so this errs toward "no match" whenever
// there's real ambiguity, rather than trying to disambiguate on its own.
// Both sides have a SKU and they differ → a different item, whatever the
// title says. Confirmed live: Adidas KBG277 (Ultimate365 Tapered Golf
// Pants, Wonder Sage) title-matched the store's existing single-variant
// "Ultimate365 Tapered Golf Pants" (Hemp, IU2835) — a bulk import would
// have marked HEMP in stock and linked the supplier to it, and the Wonder
// Sage pants would never have been added. A different colour/article is
// not "already in the store". Missing SKU on either side → no opinion.
//
// Golf Care's own store SKUs ("WC-16323" — 4,878 of ~4,900 live variants)
// are internal codes, never a maker's article number, so a supplier's code
// can't be compared with them: treated as "no SKU", or nearly every
// legitimate title match would flip to "new" (checked against past bulk
// imports: 19 of 20 linked items would have).
const INTERNAL_STORE_SKU_RE = /^WC-\d+$/i;
function skuConflicts(sku, otherSku) {
  if (!sku || !otherSku) return false;
  if (INTERNAL_STORE_SKU_RE.test(String(otherSku).trim())) return false;
  return String(sku).trim().toLowerCase() !== String(otherSku).trim().toLowerCase();
}

// Model-word rule. Title overlap alone (>= 60% of the supplier's words)
// let look-alikes through, because the shared words were generic:
// "Titleist AVX Dozen" matched "Titleist Pro V1 Golf Balls (Dozen)",
// "GS Solid Lisle Black Shirt" matched "Jungle Leaves Lisle Golf Polo -
// Black", "Pro SL Carbon BOA" matched "Pro SLX Boa XW Spikeless Golf
// Shoes". What tells products apart is the model word (avx, solid, carbon),
// so every MODEL WORD in the incoming title must also be in the store
// title. A model word is one that appears in only a few store titles
// (1..MODEL_WORD_MAX_TITLES) — measured from the live catalog, not a
// hand-kept list — and isn't:
//   - a brand: store titles mostly leave the brand out ("adidas" is in 7
//     of 1,847 titles), so brand words come from Product.vendor instead;
//   - a packaging/marketing word that's rare in titles but says nothing
//     about which product it is (GENERIC_WORDS);
//   - unknown to the store (0 titles): likely supplier shorthand ("GS"),
//     which no store title could contain anyway.
const MODEL_WORD_MAX_TITLES = 20;
const GENERIC_WORDS = new Set([
  "dozen", "pack", "pcs", "pc", "piece", "pieces", "box", "new", "edition",
  "mens", "womens", "ladies", "unisex", "junior", "kids", "youth",
  "2022", "2023", "2024", "2025", "2026", "2027",
]);
const STATS_TTL_MS = 10 * 60 * 1000;
let titleStatsCache = null;

async function getTitleStats() {
  if (titleStatsCache && Date.now() - titleStatsCache.at < STATS_TTL_MS) return titleStatsCache;
  const products = await prisma.product.findMany({
    where: { status: "active" },
    select: { title: true, vendor: true },
  });
  const titleCount = new Map();
  const brandWords = new Set();
  for (const p of products) {
    for (const t of new Set(tokenize(p.title))) titleCount.set(t, (titleCount.get(t) || 0) + 1);
    for (const t of tokenize(p.vendor)) brandWords.add(t);
  }
  titleStatsCache = { at: Date.now(), titleCount, brandWords };
  return titleStatsCache;
}

function modelWords(titleTokens, stats, extraBrandWords) {
  return titleTokens.filter((t) => {
    const n = stats.titleCount.get(t) || 0;
    return (
      n >= 1 &&
      n <= MODEL_WORD_MAX_TITLES &&
      !GENERIC_WORDS.has(t) &&
      !stats.brandWords.has(t) &&
      !extraBrandWords.has(t)
    );
  });
}

async function findExistingCatalogMatch({ title, sku, variantOptions, brand }) {
  // status: "active" only — handleProductDelete (shopifyWebhookController.js)
  // soft-deletes: a product removed on Shopify gets status flipped to
  // "archived" here, the row is never actually removed (so order history
  // etc. stays intact). Without this filter, a deleted-on-Shopify product
  // still sitting in our table (archived, or "draft" pending its own
  // approval) would look like a legitimate "this already exists" match.
  if (sku) {
    const bySku = await prisma.variant.findFirst({
      where: { sku: { equals: sku, mode: "insensitive" }, Product: { status: "active" } },
      include: { Product: true },
    });
    if (bySku) return { product: bySku.Product, variant: bySku };
  }

  const titleTokens = tokenize(title);
  if (titleTokens.length === 0) return null;

  const candidates = await prisma.product.findMany({
    where: {
      status: "active",
      OR: titleTokens.slice(0, 6).map((w) => ({ title: { contains: w, mode: "insensitive" } })),
    },
    include: { Variant: true },
    take: 15,
  });
  if (candidates.length === 0) return null;

  const stats = await getTitleStats();
  const required = modelWords(titleTokens, stats, new Set(tokenize(brand)));
  const scored = candidates
    .map((p) => {
      const candidateTokens = new Set(tokenize(p.title));
      const overlap = titleTokens.filter((t) => candidateTokens.has(t)).length;
      return { product: p, score: overlap / titleTokens.length, candidateTokens };
    })
    .filter((s) => s.score >= 0.6)
    .filter((s) => required.every((t) => s.candidateTokens.has(t)))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  // Require a clearly dominant top match, not just the highest of several
  // similar scores — same "don't guess" reasoning as the chat's own
  // matchSupplierProduct heuristic.
  if (scored.length > 1 && scored[1].score >= scored[0].score - 0.15) return null;

  const product = scored[0].product;
  if (product.Variant.length === 0) return null;
  if (product.Variant.length === 1) {
    if (skuConflicts(sku, product.Variant[0].sku)) return null;
    return { product, variant: product.Variant[0] };
  }

  const optionTokens = (variantOptions || []).flatMap((o) => tokenize(o.value));
  if (optionTokens.length === 0) return null; // multiple variants, nothing to disambiguate with

  const variantScored = product.Variant.map((v) => {
    const vTokens = new Set(tokenize(v.title));
    const overlap = optionTokens.filter((t) => vTokens.has(t)).length;
    return { variant: v, score: overlap / optionTokens.length };
  }).sort((a, b) => b.score - a.score);

  if (variantScored[0].score < 0.5) return null;
  if (variantScored.length > 1 && variantScored[1].score >= variantScored[0].score) return null;

  if (skuConflicts(sku, variantScored[0].variant.sku)) return null;
  return { product, variant: variantScored[0].variant };
}

module.exports = { tokenize, findExistingPendingDraft, findExistingCatalogMatch };
