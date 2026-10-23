// src/controllers/insightsController.js
// v2 — extracts contentPickerData from suggest_campaign_content tool call,
// no longer extracts campaignData from draft_campaign (frontend now calls
// POST /api/campaigns/draft directly).

const { runToolLoop } = require("../services/agentEngine/toolLoop");
const { computeCost } = require("../services/agentEngine/modelPricing");
const insightsAgentConfig = require("../services/insightsAgent/insightsAgentConfig");
const { prisma } = require("../lib/prisma");
const { env } = require("../config/env");

const FALLBACK_REPLY =
  "I wasn't able to work that out — try rephrasing, or ask something more specific.";

const CAMPAIGN_INTENT_RE =
  /\b(campaign|broadcast|send|message|announce|promotion|promo|offer|blast|bulk|whatsapp|template|notify|reach out|follow.?up|tournament|invite)\b/i;

function pickInsightsModel(message, history) {
  if (CAMPAIGN_INTENT_RE.test(message)) return env.anthropicModelSonnet;
  return env.anthropicModelHaiku;
}

// ── Per-session cost accumulator ─────────────────────────────────────────────
//
// Tracks cumulative LLM spend across all turns within a single browser/
// conversation session. Key = staffUserId (or "anon" for unauthenticated).
// Cleared when the process restarts — this is a console-visibility helper,
// not durable billing data (that's insightsUsage rows in the DB).
//
const _sessionCost = new Map(); // staffUserId|"anon" -> { usd, inr, turns }

function logUsage({
  staffUserId,
  question,
  model,
  usage,
  toolCallLog,
  outcome,
}) {
  const cost = computeCost(model, usage);
  console.log(
    `[insights] model=${model} cost: $${cost.usd.toFixed(6)} / ₹${cost.inr.toFixed(4)} ` +
      `(in=${usage?.inputTokens || 0} out=${usage?.outputTokens || 0} ` +
      `cache_created=${usage?.cacheCreationTokens || 0} cache_read=${usage?.cacheReadTokens || 0} ` +
      `tools=${toolCallLog?.length || 0} outcome=${outcome})`,
  );

  // Accumulate into session bucket and print a clear per-turn cost line
  const key = staffUserId || "anon";
  const prev = _sessionCost.get(key) || { usd: 0, inr: 0, turns: 0 };
  const next = {
    usd: prev.usd + cost.usd,
    inr: prev.inr + cost.inr,
    turns: prev.turns + 1,
  };
  _sessionCost.set(key, next);
  console.log(
    `[insights] 💰 Turn cost: $${cost.usd.toFixed(4)} / ₹${cost.inr.toFixed(2)}` +
      `  |  Session total (${next.turns} turn${next.turns === 1 ? "" : "s"}): $${next.usd.toFixed(4)} / ₹${next.inr.toFixed(2)}`,
  );

  const operations = [
    prisma.insightsUsage.create({
      data: {
        staffUserId: staffUserId || null,
        question,
        model,
        inputTokens: usage?.inputTokens || 0,
        outputTokens: usage?.outputTokens || 0,
        costUsd: cost.usd,
        costInr: cost.inr,
        toolCallCount: toolCallLog?.length || 0,
        outcome,
      },
    }),
  ];

  if (staffUserId) {
    operations.push(
      prisma.staffUser.update({
        where: { id: staffUserId },
        data: {
          totalInsightsCostUsd: { increment: cost.usd },
          totalInsightsCostInr: { increment: cost.inr },
        },
      }),
    );
  }

  prisma
    .$transaction(operations)
    .then(() => console.log("[insights] usage row saved"))
    .catch((err) =>
      console.error("[insights] usage logging FAILED:", err.message),
    );
}

async function askInsights(req, res) {
  const { message, history } = req.body;

  if (!message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }

  const priorTurns = Array.isArray(history)
    ? history
        .filter(
          (h) =>
            h &&
            (h.role === "user" || h.role === "assistant") &&
            typeof h.text === "string",
        )
        .map((h) => ({ role: h.role, content: h.text }))
    : [];

  const question = message.trim();
  const fullHistory = [...priorTurns, { role: "user", content: question }];

  const model = pickInsightsModel(question, priorTurns);
  console.log(
    `[insights] turn model=${model} message="${question.slice(0, 60)}"`,
  );

  const staffContext = req.staffUser
    ? `\n\nThe staff member talking to you right now is ${req.staffUser.name} (role: ${req.staffUser.role}). Greet them by name if it's their first message.`
    : "";
  const systemPrompt = insightsAgentConfig.systemPrompt + staffContext;

  try {
    const result = await runToolLoop({
      systemPrompt,
      tools: insightsAgentConfig.tools,
      toolHandlers: insightsAgentConfig.buildToolHandlers({
        staffUserId: req.staffUser?.id || null,
      }),
      history: fullHistory,
      maxIterations: env.agentMaxToolIterations || 8,
      model,
    });

    logUsage({
      staffUserId: req.staffUser?.id,
      question,
      model,
      usage: result.usage,
      toolCallLog: result.toolCallLog,
      outcome: result.hitIterationCap ? "iteration_cap" : "completed",
    });

    if (result.hitIterationCap || !result.finalText) {
      return res.json({ reply: FALLBACK_REPLY });
    }

    // v2: extract contentPickerData from suggest_campaign_content tool call.
    // This replaces the old campaignData extraction from draft_campaign.
    let contentPickerData = null;
    const pickerCall = result.toolCallLog
      ?.slice()
      .reverse()
      .find(
        (t) =>
          t.tool === "suggest_campaign_content" &&
          t.output?.success === true &&
          t.output?.action === "SHOW_CONTENT_PICKER",
      );
    if (pickerCall) {
      contentPickerData = {
        campaignName: pickerCall.output.campaignName,
        audienceRules: pickerCall.output.audienceRules,
        audienceSize: pickerCall.output.audienceSize,
        intent: pickerCall.output.intent,
        variants: pickerCall.output.variants,
        recommendedIndex: pickerCall.output.recommendedIndex,
        // Pass through the original agent prompt for the draft record
        agentPrompt: question,
      };
    }

    console.log(
      "[insights] toolCallLog:",
      JSON.stringify(
        result.toolCallLog?.map((t) => ({
          tool: t.tool,
          action: t.output?.action,
          success: t.output?.success,
        })),
        null,
        2,
      ),
    );
    console.log("[insights] contentPicker being returned:", contentPickerData);

    res.json({ reply: result.finalText, contentPicker: contentPickerData });
  } catch (err) {
    console.error("askInsights error:", err);
    logUsage({
      staffUserId: req.staffUser?.id,
      question,
      model,
      usage: null,
      toolCallLog: [],
      outcome: "error",
    });
    res.status(500).json({ error: "Insights couldn't process that right now" });
  }
}

module.exports = { askInsights };
