// src/services/supplierAgent/productResearch.js
//
// Isolated, minimal-context research call for a new product's specs and
// image — deliberately kept OUT of the main supplier conversation.
// Confirmed live: doing web_search/web_fetch inline, as tools the main
// agent calls directly, pulls the full raw scraped webpage (thousands of
// tokens — search result citation blobs plus the whole fetched page) into
// the SAME growing context that also carries the entire supplier
// conversation's system prompt and history, and that inflated context
// gets resent on every remaining iteration of that turn. One product's
// research alone cost 107K input tokens that way.
//
// This runs its own tiny, independent runToolLoop() call — no supplier
// context, no conversation history, no other tools, nothing else — and
// returns just a short distilled summary. The raw scraped page never
// touches the main agent's context at all; only this summary does, as a
// single cheap tool result. Real token usage AND its correctly-priced
// cost are reported back via context.extraUsage (see
// contextAssembler.js) so it still shows up in the real cost log instead
// of silently going untracked.
//
// Model: Claude Haiku 5.5 (Nov 2026). This used to be pinned to Sonnet 4.6
// because Haiku 4.5 unreliably answered with ONLY the JSON object —
// two real lookups came back "research_response_unparseable". Two things
// changed: Haiku 5.5 follows instructions far better (in a side-by-side
// test on real catalog products it got correct specs for both products
// and the only real product photo, at ~₹1.4 per product vs ~₹23 on the
// old uncapped Sonnet setup), and parseResearchResponse below now pulls
// the JSON object out from between any narration the model writes around
// it, instead of failing the whole lookup on one stray sentence.
// RESEARCH_MODEL can be overridden with PRODUCT_RESEARCH_MODEL.

const { runToolLoop } = require("../agentEngine/toolLoop");
const { computeCost } = require("../agentEngine/modelPricing");

const RESEARCH_MODEL = process.env.PRODUCT_RESEARCH_MODEL || "claude-haiku-5-5";

const RESEARCH_SYSTEM_PROMPT = `You are a focused product-research assistant for a golf retail catalog. Given a product name (and optionally a brand), use web_search, then web_fetch on the most relevant result (prefer the brand's own site or a major retailer), to find real specs and a real product image. Keep it short: one good search and one or two page reads is normally enough.

Respond with ONLY a JSON object, no other text, no markdown code fences:
{"specs": "...", "imageUrl": "..." or null, "sourceNotes": "..."}

- specs: 2-4 sentences of prose (materials, construction, features, condition) — never restate the brand, SKU, or size, those aren't needed here.
- imageUrl: a real, direct image URL you found via web_fetch (an og:image meta tag or a product image src) — never a product PAGE url, never a guessed or constructed url. Use null if you can't confirm a real one.
- sourceNotes: one short sentence citing where this came from.

If you can't find anything useful after searching, respond with {"specs": null, "imageUrl": null, "sourceNotes": "not found"}.`;

// max_uses 2 each (was 3) and max_content_tokens caps how much of each
// fetched page enters the prompt — uncapped, one retailer product page
// (menus, reviews, footers) ran 30-50K tokens, and that input, not the
// answer, was most of the research bill. Basic tool versions: Haiku 5.5
// doesn't support the newer _20260209 ones.
const RESEARCH_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 2 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 2, max_content_tokens: 5000 },
];

// Takes the substring between the first "{" and the last "}" — with web
// tools the model may write narration ("Let me fetch that page...")
// before its JSON answer, which would otherwise fail JSON.parse.
function parseResearchResponse(finalText) {
  const raw = (finalText || "").replace(/```(json)?/gi, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  try {
    if (start === -1 || end <= start) throw new Error("no JSON object");
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return { specs: null, imageUrl: null, sourceNotes: "research_response_unparseable" };
  }
}

/**
 * @param {object} input
 * @param {string} input.title
 * @param {string} [input.brand]
 * @returns {Promise<{specs: string|null, imageUrl: string|null, sourceNotes: string|null, usage: {inputTokens: number, outputTokens: number}, cost: {usd: number, inr: number}}>}
 */
async function researchProductSpecs({ title, brand }) {
  const query = brand ? `${brand} ${title}` : title;
  const { finalText, usage } = await runToolLoop({
    systemPrompt: RESEARCH_SYSTEM_PROMPT,
    tools: RESEARCH_TOOLS,
    toolHandlers: {},
    history: [{ role: "user", content: `Product: ${query}` }],
    maxIterations: 4,
    model: RESEARCH_MODEL,
    effort: "low", // simple lookup — no need to spend output tokens thinking
  });

  const parsed = parseResearchResponse(finalText);
  return {
    specs: parsed.specs || null,
    imageUrl: parsed.imageUrl || null,
    sourceNotes: parsed.sourceNotes || null,
    usage,
    cost: computeCost(RESEARCH_MODEL, usage),
  };
}

module.exports = { researchProductSpecs };
