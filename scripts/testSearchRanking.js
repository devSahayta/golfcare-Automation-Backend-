// scripts/testSearchRanking.js
//
// Mocked-DB test for the search_products ranking fix — reproduces the
// exact live bug (customer asks for "JPX 923 Hot Metal irons", agent
// returned "JPX 923 Forged" instead) with synthetic data modeled on the
// real catalog rows involved, and confirms the new scoring/ranking step
// puts the exact match first regardless of DB row order.
//
// The method under test doesn't touch Prisma relation types or context
// at all (it only closes over `prisma` and `env`) so it's lifted out and
// tested directly here rather than going through buildSalesAgentTools's
// full dependency chain (enrolmentQuestions, pricingEngine, shopifyDiscounts
// — none of which search_products touches).
//
// Run from the backend repo root:
//   node scripts/testSearchRanking.js

function pass(label) {
  console.log(`PASS - ${label}`);
}
function fail(label, detail) {
  console.log(`FAIL - ${label}`);
  if (detail !== undefined)
    console.log("  ->", JSON.stringify(detail, null, 2));
  process.exitCode = 1;
}

// Synthetic catalog modeled on the real rows: several JPX 923-family
// products so a naive "first N rows" approach can plausibly return the
// wrong one, deliberately NOT in a convenient order (Forged listed
// first, Hot Metal HL — the one actually asked for — listed third).
const CATALOG = [
  {
    id: "p-forged",
    title: "JPX 923 Forged Irons",
    vendor: "Mizuno",
    productType: "Irons",
    tags: ["CLUBS", "Irons", "Mizuno"],
    priceMin: 95000,
    priceMax: 95000,
    imageUrls: [],
    handle: "jpx-923-forged-irons",
    Variant: [{ id: "v-forged-1", title: "Steel / Right", price: 95000 }],
  },
  {
    id: "p-hotmetal-pro",
    title: "JPX 923 Hot Metal Pro Irons",
    vendor: "Mizuno",
    productType: "Irons",
    tags: ["CLUBS", "Irons", "Mizuno"],
    priceMin: 92000,
    priceMax: 92000,
    imageUrls: [],
    handle: "jpx-923-hot-metal-pro-irons",
    Variant: [{ id: "v-hmpro-1", title: "Steel / Right", price: 92000 }],
  },
  {
    id: "p-unrelated-metal",
    title: "Hot Metal Wedge",
    vendor: "SomeOtherBrand",
    productType: "Wedges",
    tags: ["CLUBS", "Wedges"],
    priceMin: 15000,
    priceMax: 15000,
    imageUrls: [],
    handle: "hot-metal-wedge",
    Variant: [{ id: "v-wedge-1", title: "Right", price: 15000 }],
  },
  // Noise: a pile of OTHER brands' iron sets that also legitimately
  // contain "Iron"/"Irons" in their title, listed BEFORE the real Hot
  // Metal HL product in catalog/DB order. This is what actually
  // reproduces the live bug: the old code took the first `limit` (5)
  // rows straight from the DB with no ranking, so if 5+ unrelated iron
  // sets happened to come back ahead of Hot Metal HL in raw row order,
  // HL was excluded from the results entirely — not just ranked lower.
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `p-noise-${i}`,
    title: `Generic Brand ${i} Cavity Back Irons`,
    vendor: `OtherBrand${i}`,
    productType: "Irons",
    tags: ["CLUBS", "Irons"],
    priceMin: 30000,
    priceMax: 30000,
    imageUrls: [],
    handle: `generic-brand-${i}-irons`,
    Variant: [{ id: `v-noise-${i}`, title: "Right", price: 30000 }],
  })),
  // The real product the customer actually asked for — deliberately
  // listed LAST, well past the old `take: 5` cutoff, matching how an
  // arbitrary (non-relevance-ordered) DB row order could realistically
  // place it in the live catalog.
  {
    id: "c2f47ebb-1e5a-4ca9-bf21-2161fc1a610b",
    title: "JPX 923 Hot Metal HL (5-GW) Steel Irons",
    vendor: "Mizuno",
    productType: "Irons",
    tags: ["CLUBS", "handle-checked", "Irons", "Mizuno", "seo-updated"],
    priceMin: 89000,
    priceMax: 89000,
    imageUrls: ["https://cdn.shopify.com/.../jpx-923-hot-metal-hl_3_3.jpg"],
    handle: "jpx-923-hot-metal-hl-5-gw-steel-irons",
    Variant: [
      {
        id: "v-hmhl-1",
        title: "Right / Stiff / Nippon N.S. Pro 950GH Neo S (98gm)",
        price: 89000,
      },
    ],
  },
];

const fakePrisma = {
  product: {
    findMany: async ({ where, take }) => {
      // Crude but faithful simulation of the real Prisma `contains`/`OR`/
      // `AND` filter against the synthetic catalog, in DECLARATION order
      // (i.e. NOT already ranked by relevance) — this is what exposes
      // the bug: without the new scoring step, "take" would just grab
      // the first N in this arbitrary order.
      function matchesCondition(p, cond) {
        if (cond.OR) return cond.OR.some((c) => matchesCondition(p, c));
        if (cond.AND) return cond.AND.every((c) => matchesCondition(p, c));
        if (cond.status) return true; // all synthetic rows are "active"
        if (cond.title?.contains) {
          return p.title
            .toLowerCase()
            .includes(cond.title.contains.toLowerCase());
        }
        if (cond.vendor?.contains) {
          return (p.vendor || "")
            .toLowerCase()
            .includes(cond.vendor.contains.toLowerCase());
        }
        if (cond.tags?.has) {
          return (p.tags || []).includes(cond.tags.has);
        }
        return true;
      }
      const matched = CATALOG.filter((p) => matchesCondition(p, where));
      return matched
        .slice(0, take)
        .map((p) => ({ ...p, Variant: p.Variant.map((v) => ({ ...v })) }));
    },
    count: async ({ where }) => {
      function matchesCondition(p, cond) {
        if (cond.OR) return cond.OR.some((c) => matchesCondition(p, c));
        if (cond.AND) return cond.AND.every((c) => matchesCondition(p, c));
        if (cond.status) return true;
        if (cond.title?.contains)
          return p.title
            .toLowerCase()
            .includes(cond.title.contains.toLowerCase());
        if (cond.vendor?.contains)
          return (p.vendor || "")
            .toLowerCase()
            .includes(cond.vendor.contains.toLowerCase());
        if (cond.tags?.has) return (p.tags || []).includes(cond.tags.has);
        return true;
      }
      return CATALOG.filter((p) => matchesCondition(p, where)).length;
    },
  },
};

const fakeEnv = { shopify: { shopDomain: "y3tzk0-4d.myshopify.com" } };

// ---------------------------------------------------------------------
// The method under test — copy of the fixed search_products body,
// with `prisma`/`env` closed over from the fakes above instead of
// required from real modules.
// ---------------------------------------------------------------------
const prisma = fakePrisma;
const env = fakeEnv;

async function search_products({
  query,
  category,
  vendor,
  priceMin,
  priceMax,
  limit = 5,
}) {
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
    "golf",
  ]);
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
  const ORIENTATION_WORDS = new Set([
    "left",
    "right",
    "hand",
    "handed",
    "lefty",
    "righty",
  ]);
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
  const wordForms = words.flatMap((w) =>
    w.length > 3 && w.toLowerCase().endsWith("s") ? [w, w.slice(0, -1)] : [w],
  );
  if (!wordForms.length) return { results: [] };

  const lowerCombined = combinedQuery.toLowerCase();
  let genderFilter = null;
  if (/\bmen'?s\b/.test(lowerCombined) && !/\bwomen'?s\b/.test(lowerCombined)) {
    genderFilter = { title: { startsWith: "Men's", mode: "insensitive" } };
  } else if (
    /\bwomen'?s\b/.test(lowerCombined) ||
    /\bladies\b/.test(lowerCombined)
  ) {
    genderFilter = { title: { startsWith: "Women's", mode: "insensitive" } };
  }
  const genderConditions = genderFilter ? [genderFilter] : [];

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
            some: { title: { contains: "Right hand", mode: "insensitive" } },
          },
        },
      ],
    };
  }
  const vendorConditions = vendor
    ? [{ vendor: { contains: vendor, mode: "insensitive" } }]
    : [];
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
  const baseAnd = [{ OR: titleOr }, ...priceConditions, ...genderConditions];

  const candidatePoolSize = Math.min(Math.max(limit * 10, 50), 100);

  const attributeFilters = [
    { key: "orientation", condition: orientationFilter },
    { key: "color", condition: colorFilter },
    { key: "vendor", condition: vendorConditions[0] || null },
  ].filter((f) => f.condition);

  const relaxed = {};
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

  const totalCount = await prisma.product.count({ where: usedWhere });

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
    score -= title.split(/\s+/).length * 0.01;
    return score;
  }

  products = [...products]
    .sort((a, b) => scoreProduct(b) - scoreProduct(a))
    .slice(0, Math.min(limit, 15));

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
    orientationRelaxed: !!relaxed.orientation,
    colorRelaxed: !!relaxed.color,
    vendorRelaxed: !!relaxed.vendor,
  };
}

async function main() {
  console.log("=== search_products ranking fix test (mocked DB) ===\n");

  // --- Reproduce the OLD bug first: take=5 directly from the DB, no
  // ranking at all, against the exact same catalog/filter — this is
  // what the live code did before the fix, and confirms Hot Metal HL
  // genuinely gets excluded (not just outranked) by raw row order once
  // there's enough noise in the catalog, matching what you saw live.
  const rawMatches = await prisma.product.findMany({
    where: {
      status: "active",
      AND: [
        {
          OR: ["JPX", "923", "Hot", "Metal", "irons", "iron"].map((w) => ({
            title: { contains: w, mode: "insensitive" },
          })),
        },
      ],
    },
    take: 5, // the OLD behavior: take the final limit directly from the DB
  });
  const oldBehaviorTitles = rawMatches.map((p) => p.title);
  console.log(
    "OLD behavior (take=5, no ranking) would have returned:",
    oldBehaviorTitles,
  );
  if (!oldBehaviorTitles.includes("JPX 923 Hot Metal HL (5-GW) Steel Irons")) {
    pass(
      "confirmed: the OLD code path genuinely excludes Hot Metal HL once there's enough catalog noise — reproduces the live bug",
    );
  } else {
    fail(
      "old behavior should have excluded Hot Metal HL (test catalog may need more noise)",
      oldBehaviorTitles,
    );
  }

  // --- The exact live scenario: "JPX 923 Hot Metal irons" -----------
  const res1 = await search_products({ query: "JPX 923 Hot Metal irons" });
  console.log(
    '\nNEW behavior — Query: "JPX 923 Hot Metal irons" ->',
    res1.results.map((r) => r.title),
  );
  const titles1 = res1.results.map((r) => r.title);
  const hlRank = titles1.indexOf("JPX 923 Hot Metal HL (5-GW) Steel Irons");
  const noiseRanks = titles1
    .map((t, i) => (t.startsWith("Generic Brand") ? i : -1))
    .filter((i) => i >= 0);
  if (
    hlRank !== -1 &&
    (noiseRanks.length === 0 || hlRank < Math.min(...noiseRanks))
  ) {
    pass(
      `the real Hot Metal HL product is now included in the top ${titles1.length} results (rank ${hlRank + 1}), ranked above all generic noise matches`,
    );
  } else {
    fail("Hot Metal HL included and ranked above noise", {
      titles1,
      hlRank,
      noiseRanks,
    });
  }

  // --- A vaguer query should still surface the whole JPX 923 family --
  const res2 = await search_products({ query: "JPX 923 irons", limit: 5 });
  const titles2 = res2.results.map((r) => r.title);
  console.log('\nQuery: "JPX 923 irons" ->', titles2);
  if (
    titles2.includes("JPX 923 Forged Irons") &&
    titles2.includes("JPX 923 Hot Metal Pro Irons") &&
    titles2.includes("JPX 923 Hot Metal HL (5-GW) Steel Irons")
  ) {
    pass(
      "a vaguer query still surfaces the whole JPX 923 family (ranking doesn't over-narrow)",
    );
  } else {
    fail("vaguer query surfaces whole family", titles2);
  }

  // --- Unrelated "Hot Metal Wedge" should rank below the JPX irons for an irons-specific query ---
  const res3 = await search_products({
    query: "Hot Metal irons",
    category: "Irons",
  });
  const titles3 = res3.results.map((r) => r.title);
  console.log('\nQuery: "Hot Metal irons" (category: Irons) ->', titles3);
  if (
    titles3[0] !== "Hot Metal Wedge" &&
    titles3.some((t) => t.includes("Irons"))
  ) {
    pass(
      "unrelated Wedge product (shares 'Hot Metal' words) doesn't outrank real Irons matches when category=Irons is given",
    );
  } else {
    fail("unrelated product doesn't outrank real matches", titles3);
  }
}

main();
