// src/controllers/insightsController.js
// v2 — extracts contentPickerData from suggest_campaign_content tool call,
// no longer extracts campaignData from draft_campaign (frontend now calls
// POST /api/campaigns/draft directly).

const { runToolLoop } = require("../services/agentEngine/toolLoop");
const { computeCost } = require("../services/agentEngine/modelPricing");
const insightsAgentConfig = require("../services/insightsAgent/insightsAgentConfig");
const { prisma } = require("../lib/prisma");
const { env } = require("../config/env");

const TIMEZONE = process.env.SCHEDULER_TIMEZONE || "Asia/Kolkata";

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

  // Ground "today", "tomorrow", "Monday 10am" etc. against the REAL current
  // date/time — without this, STEP 5's scheduling instructions in
  // insightsAgentConfig.js have nothing to resolve a relative date against,
  // and the model falls back to guessing from its training distribution.
  // Confirmed in production: a staff member asked to schedule for
  // "12:55pm today" and the model resolved "today" to 2025-07-23 (over a
  // year in the past), which schedule_campaign_broadcast correctly rejected
  // as not-in-the-future — but the agent then told the staff member the
  // wrong reason ("12:55pm has already passed") instead of the real one
  // (it had the wrong date entirely), because it still didn't know the
  // actual date even after the rejection. Injecting this every turn fixes
  // both: the model gets the date right the first time, and if it's ever
  // still off, this is in context so the real cause is visible.
  const nowIST = new Date().toLocaleString("en-IN", {
    timeZone: TIMEZONE,
    dateStyle: "full",
    timeStyle: "short",
  });
  const dateContext = `\n\nThe current date and time is ${nowIST} (${TIMEZONE}). Use this as the ground truth whenever you need to resolve "today", "tomorrow", a weekday name, or any other relative date/time — never guess or assume a date from anywhere else.`;

  const systemPrompt =
    insightsAgentConfig.systemPrompt + staffContext + dateContext;

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

    // v2: extract savedCampaignData from save_campaign_draft tool call.
    // When the agent saves on behalf of the staff member (verbal confirm),
    // the frontend uses this to render a CampaignSavedCard with a redirect button.
    let savedCampaignData = null;
    const saveCall = result.toolCallLog
      ?.slice()
      .reverse()
      .find(
        (t) =>
          t.tool === "save_campaign_draft" &&
          t.output?.success === true &&
          t.output?.action === "SHOW_SAVED_CAMPAIGN_CARD",
      );
    if (saveCall) {
      savedCampaignData = {
        id: saveCall.output.campaignId,
        campaignId: saveCall.output.campaignId,
        name: saveCall.output.campaignName,
        campaignName: saveCall.output.campaignName,
        audienceSize: saveCall.output.audienceSize,
        headerType: saveCall.output.headerType || null,
        headerImageUrl: saveCall.output.headerImageUrl || null,
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
    console.log("[insights] savedCampaign being returned:", savedCampaignData);

    res.json({
      reply: result.finalText,
      contentPicker: contentPickerData,
      savedCampaign: savedCampaignData,
    });
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
