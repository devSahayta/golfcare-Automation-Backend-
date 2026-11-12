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
async function findExistingCatalogMatch({ title, sku, variantOptions }) {
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

  const scored = candidates
    .map((p) => {
      const candidateTokens = new Set(tokenize(p.title));
      const overlap = titleTokens.filter((t) => candidateTokens.has(t)).length;
      return { product: p, score: overlap / titleTokens.length };
    })
    .filter((s) => s.score >= 0.6)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return null;
  // Require a clearly dominant top match, not just the highest of several
  // similar scores — same "don't guess" reasoning as the chat's own
  // matchSupplierProduct heuristic.
  if (scored.length > 1 && scored[1].score >= scored[0].score - 0.15) return null;

  const product = scored[0].product;
  if (product.Variant.length === 0) return null;
  if (product.Variant.length === 1) return { product, variant: product.Variant[0] };

  const optionTokens = (variantOptions || []).flatMap((o) => tokenize(o.value));
  if (optionTokens.length === 0) return null; // multiple variants, nothing to disambiguate with

  const variantScored = product.Variant.map((v) => {
    const vTokens = new Set(tokenize(v.title));
    const overlap = optionTokens.filter((t) => vTokens.has(t)).length;
    return { variant: v, score: overlap / optionTokens.length };
  }).sort((a, b) => b.score - a.score);

  if (variantScored[0].score < 0.5) return null;
  if (variantScored.length > 1 && variantScored[1].score >= variantScored[0].score) return null;

  return { product, variant: variantScored[0].variant };
}

module.exports = { tokenize, findExistingPendingDraft, findExistingCatalogMatch };
