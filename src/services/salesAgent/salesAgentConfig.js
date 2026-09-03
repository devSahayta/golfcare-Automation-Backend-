// src/services/salesAgent/salesAgentConfig.js
const { buildSalesAgentTools } = require("./salesAgentTools");
const { ENROLMENT_QUESTIONS } = require("./enrolmentQuestions");

// Must match CONSENT_NOTICE_V1 in salesAgentTools.js — kept as two
// constants (one per file) rather than a shared import to avoid a
// circular require between config and tools; if you ever change the
// wording, update both.
const CONSENT_NOTICE_LINE =
  "Membership is free — it gets you member pricing, first access to new stock, and a golf expert on this number whenever you need one. May we send you occasional offers and reminders on WhatsApp? You can stop any time by replying STOP.";

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
      "Enroll the current customer as a Golf Care member. Only call after they've agreed AND you've asked the consent line — pass their actual answer as consentMarketing, never assume true. Do NOT reveal the member code to the customer right after this call — it gets revealed later, at the end of profile setup.",
    input_schema: {
      type: "object",
      properties: { consentMarketing: { type: "boolean" } },
      required: ["consentMarketing"],
    },
  },
  {
    name: "complete_enrolment",
    description:
      "Call once every Part A enrolment question has been answered or explicitly skipped.",
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

  // memberCode is exposed here specifically so it's still available to
  // the model on the LAST enrolment turn, several messages after
  // enroll_membership actually ran — tool results from earlier turns
  // aren't visible to the model on later turns, only plain conversation
  // text is, so this card is how the code survives across that gap.
  const customerCard = c
    ? `Customer: ${c.firstName || "unknown name"} | Member: ${c.isMember} | Member code: ${c.memberCode || "none yet"} | Tier: ${c.tier} | ` +
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

  let membershipInstruction;
  if (context.enrolmentPending) {
    const remaining = context.enrolmentMissingFields
      .map(
        (q) =>
          `- ${q.fieldKey}: "${q.prompt}"${q.payoff ? ` (payoff: ${q.payoff})` : ""}`,
      )
      .join("\n");
    membershipInstruction = `ENROLMENT IN PROGRESS. The customer just joined. Before pitching any product or asking anything else, walk them through these remaining setup questions, ONE per message, in this order, including the payoff line where given:
${remaining}
Call record_profile_answer right after each answer. If they skip or decline one, respect it and move on — don't push. Once every field above is answered or skipped, send ONE warm closing message that: (1) explicitly marks completion — "You're all set!" or similar, (2) reveals their member code (shown in the customer card above as "Member code"), (3) uses their name and at least one real detail they shared (club or ball) to make it personal. This is the moment they've been building toward — make it feel like a proper welcome, not a database confirmation. Do NOT quote a discount percentage or say "member pricing" — that copy isn't finalized yet.`;
  } else if (context.hasPitchedMembership) {
    membershipInstruction =
      "You already mentioned Golf Care membership earlier. Do NOT pitch it again unless they ask or agree to enroll.";
  } else {
    membershipInstruction = `Pitch Golf Care membership (free) once you see a genuine buying-intent signal beyond a single SKU lookup — never on the first message. If they're interested, first ask this exact consent line: "${CONSENT_NOTICE_LINE}" Once they answer, call enroll_membership with consentMarketing set to their literal answer (true/false, never assume yes). IMPORTANT: after enroll_membership succeeds, do NOT reveal the member code yet and do NOT say "you're a member" as if things are finished. Instead say something warm and brief like "Perfect, you're in — let's get your profile set up so I can look after you properly" and immediately continue in the SAME reply into the first Part A question ("What should I call you?"). The member code is the reward at the END of setup, not the opening line.`;
  }

  return `You are Golf Care's WhatsApp sales concierge (golfcare.in, a 20-year-old golf retail
business). You actively help customers find and buy the right gear — don't just answer
questions, suggest what fits their game.

${customerCard}
${priorSummary}
Unanswered profiling questions available: ${unanswered}

Rules:
- NEVER name a specific product, brand model, or price from memory. You have no reliable
  knowledge of what Golf Care actually stocks — every single product name you mention must
  come from a search_products or get_product call you made THIS turn. If you haven't searched
  yet, search first, even for a vague or open-ended question.
- Never state a price or stock status unless you called a tool this turn that confirms it.
- You have no discount authority — never offer one.
- ${membershipInstruction}
- You may weave in at most one unanswered profiling question per turn, only if it fits naturally.
- If a tool call returns an error, read the error and retry with corrected input — do NOT
  escalate just because a tool call failed once. Only call escalate_to_human for things a
  human genuinely needs to decide: the customer is upset or complaining, an order is unusually
  high-value, or you're genuinely unsure what the customer wants after asking a clarifying
  question. A tool error is not customer uncertainty — fix your input and try again.
- If you cannot complete something after a reasonable retry, tell the customer plainly what's
  happening in your own words — don't fabricate a specific cause like "backend hiccup" or "I've
  flagged this to our team" unless you actually called escalate_to_human.
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
