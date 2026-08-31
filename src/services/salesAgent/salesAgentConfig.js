// src/services/salesAgent/salesAgentConfig.js
const { buildSalesAgentTools } = require("./salesAgentTools");

const tools = [
  {
    name: "search_products",
    description:
      "Search the product catalog by free-text query, optionally filtered by category or price range.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        category: { type: "string" },
        priceMin: { type: "number" },
        priceMax: { type: "number" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_product",
    description: "Get full details for a known product or variant.",
    input_schema: {
      type: "object",
      properties: {
        productId: { type: "string" },
        variantId: { type: "string" },
      },
    },
  },
  {
    name: "check_availability",
    description:
      "Check the confirmed availability status of a variant. Never assume stock without calling this.",
    input_schema: {
      type: "object",
      properties: { variantId: { type: "string" } },
      required: ["variantId"],
    },
  },
  {
    name: "get_customer_profile",
    description:
      "Get the current customer's profile, membership status, and unanswered onboarding questions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "create_checkout_link",
    description: "Generate a Shopify checkout link for one or more variants.",
    input_schema: {
      type: "object",
      properties: {
        variantIds: { type: "array", items: { type: "string" } },
        quantities: { type: "array", items: { type: "number" } },
      },
      required: ["variantIds", "quantities"],
    },
  },
  {
    name: "escalate_to_human",
    description:
      "Hand this conversation to a human. Use when unsure, for high-value orders, or anything you shouldn't decide alone.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string" },
        urgency: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
      },
      required: ["reason", "urgency"],
    },
  },
  {
    name: "enroll_membership",
    description:
      "Enroll the current customer as a Golf Care member. Only call after the customer has agreed.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "record_profile_answer",
    description:
      "Record the customer's answer to one onboarding/profiling question.",
    input_schema: {
      type: "object",
      properties: { fieldKey: { type: "string" }, answer: { type: "string" } },
      required: ["fieldKey", "answer"],
    },
  },
];

function buildSystemPrompt(context) {
  const c = context.customer;
  const gp = context.golferProfile;

  const customerCard = c
    ? `Customer: ${c.firstName || "unknown name"} | Member: ${c.isMember} | Tier: ${c.tier} | ` +
      `Budget tier: ${gp?.budgetTier || "unknown"} | Handicap: ${gp?.handicap ?? "unknown"} | ` +
      `Preferred brands: ${(gp?.preferredBrands || []).join(", ") || "none noted"}`
    : "New customer, no profile yet.";

  const unanswered = context.unansweredQuestions.length
    ? context.unansweredQuestions
        .map((q) => `${q.fieldKey}: ${q.promptText}`)
        .join("; ")
    : "none";

  const priorSummary = context.priorSummary
    ? `Earlier in this relationship: ${context.priorSummary}`
    : "";

  const membershipInstruction = context.hasPitchedMembership
    ? "You already mentioned Golf Care membership earlier in this conversation. Do NOT pitch it again — only bring it up further if the customer asks about it themselves or agrees to enroll."
    : "Pitch Golf Care membership (free) once you see a genuine buying-intent signal beyond a single SKU lookup (budget mentioned, an advisory question, a second product category, or a returning customer) — never on the very first message. Only call enroll_membership after they agree.";

  return `You are Golf Care's WhatsApp sales concierge (golfcare.in, a 20-year-old golf retail
business). You actively help customers find and buy the right gear — don't just answer
questions, suggest what fits their game.

${customerCard}
${priorSummary}
Unanswered profiling questions available: ${unanswered}

Rules:
- Never state a price or stock status unless you called a tool this turn that confirms it.
- You have no discount authority — never offer one.
- ${membershipInstruction}
- You may weave in at most one unanswered profiling question per turn, only if it fits naturally.
- If unsure, the order is unusually high-value, or the customer is upset, call
  escalate_to_human rather than guessing.
- This is a WhatsApp message, not a document. Use WhatsApp's own formatting only: *bold*
  (single asterisk), _italic_ (single underscore), ~strikethrough~. Never use **double
  asterisks**, markdown headers (#), horizontal rules (---), or tables — none of that
  renders on WhatsApp, it'll show up as literal stray characters to the customer.
- Keep responses short and natural, like a knowledgeable person texting on WhatsApp.`;
}

function buildToolHandlers(context) {
  return buildSalesAgentTools(context);
}

module.exports = { tools, buildSystemPrompt, buildToolHandlers };
