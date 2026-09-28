// src/services/insightsAgent/insightsAgentConfig.js
const { buildInsightsAgentTools } = require("./insightsAgentTools");

// Self-identifies for AgentUsage cost tracking, same convention as
// salesAgentConfig.js / supplierAgentConfig.js.
const agentName = "insights";

const SYSTEM_PROMPT = `You are Insights, a helper for Golf Care staff using the internal dashboard.

You answer questions about customers, products, suppliers, and orders using the tools available to you. You are strictly READ-ONLY: you cannot send messages, edit records, or take any action — you only look things up and report what you find. If asked to do something beyond looking up information (send a message, approve something, change a price), say plainly that you can't do that yet and suggest where in the dashboard they could do it themselves.

Rules:
- Never invent numbers, names, or statuses. Only state facts a tool call actually returned.
- If a tool returns no results, say so plainly rather than guessing.
- Keep answers short and scannable — this renders in a small chat widget, not a report. Use plain sentences or a short list, not headers or long paragraphs.
- Currency is Indian Rupees — format as ₹12,345, not "INR" or raw numbers.
- If a question is ambiguous (e.g. "top products" with no timeframe), make a reasonable assumption (e.g. last 7 days) and say what you assumed.
- If you're not confident a tool covers what's being asked, say what you can and can't answer rather than stretching a tool's result to fit.`;

const tools = [
  {
    name: "get_top_selling_products",
    description:
      "Top-selling products by units sold, within a recent day window. Defaults to the last 7 days.",
    input_schema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "How many days back to look. Default 7.",
        },
        limit: {
          type: "number",
          description: "How many products to return. Default 5.",
        },
      },
    },
  },
  {
    name: "get_suppliers_needing_attention",
    description:
      "Active suppliers with a low reliability score or a recent timed-out/escalated stock check — i.e. suppliers 'falling behind'.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Default 5." } },
    },
  },
  {
    name: "get_customers_due_followup",
    description:
      "Members who haven't ordered in 45+ days (or never), ranked by lifetime value — customers worth a check-in.",
    input_schema: {
      type: "object",
      properties: { limit: { type: "number", description: "Default 5." } },
    },
  },
  {
    name: "search_customers",
    description:
      "Search customers by name, email, or phone. Omit query entirely to list the most recent customers instead — use this for broad requests like 'list customers' or 'show me our customers'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Default 10." },
      },
    },
  },
  {
    name: "search_products",
    description:
      "Search the product catalog by title, vendor, or product type. Omit query to list the most recently synced products — use this for broad requests like 'list products'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Default 10." },
      },
    },
  },
  {
    name: "search_suppliers",
    description:
      "Search suppliers by name or phone. Omit query to list suppliers, ranked by reliability — use this for broad requests like 'list suppliers'.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "Default 10." },
      },
    },
  },
  {
    name: "find_customers_for_price_range",
    description:
      "Finds customers whose golfer profile budget tier matches products actually priced within a ₹ range — use this for questions like 'who can afford a ₹10k-40k product' or 'customers for our premium range'.",
    input_schema: {
      type: "object",
      properties: {
        minPrice: { type: "number" },
        maxPrice: { type: "number" },
        limit: { type: "number", description: "Default 10." },
      },
      required: ["minPrice", "maxPrice"],
    },
  },
];

module.exports = {
  agentName,
  systemPrompt: SYSTEM_PROMPT,
  tools,
  buildToolHandlers: buildInsightsAgentTools,
};
