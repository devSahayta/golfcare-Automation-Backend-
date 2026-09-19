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
// Deliberately pinned to Sonnet, regardless of what the main conversation
// is configured to use (env.anthropicModel) — confirmed live: switching
// the main agent to Haiku for cost testing also silently switched this
// call to Haiku (it used to just default to env.anthropicModel), and
// Haiku unreliably followed the "respond with ONLY a JSON object"
// instruction this call depends on — two real product lookups in the same
// conversation both came back "research_response_unparseable." This is an
// infrequent, well-defined data-extraction task (only runs when a new
// product needs it, not on every turn), so paying Sonnet's rate here
// doesn't undo the savings from using Haiku for routine conversation.

const { runToolLoop } = require("../agentEngine/toolLoop");
const { computeCost } = require("../agentEngine/modelPricing");

const RESEARCH_MODEL = "claude-sonnet-4-6";

const RESEARCH_SYSTEM_PROMPT = `You are a focused product-research assistant for a golf retail catalog. Given a product name (and optionally a brand), use web_search then web_fetch on the most relevant result to find real specs and a real product image.

Respond with ONLY a JSON object, no other text, no markdown code fences:
{"specs": "...", "imageUrl": "..." or null, "sourceNotes": "..."}

- specs: 2-4 sentences of prose (materials, construction, features, condition) — never restate the brand, SKU, or size, those aren't needed here.
- imageUrl: a real, direct image URL you found via web_fetch (an og:image meta tag or a product image src) — never a product PAGE url, never a guessed or constructed url. Use null if you can't confirm a real one.
- sourceNotes: one short sentence citing where this came from.

If you can't find anything useful after searching, respond with {"specs": null, "imageUrl": null, "sourceNotes": "not found"}.`;

const RESEARCH_TOOLS = [
  { type: "web_search_20250305", name: "web_search", max_uses: 3 },
  { type: "web_fetch_20250910", name: "web_fetch", max_uses: 3 },
];

function parseResearchResponse(finalText) {
  const cleaned = (finalText || "")
    .replace(/^```(json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
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
