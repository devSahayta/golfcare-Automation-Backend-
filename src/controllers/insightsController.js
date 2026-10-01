// src/controllers/insightsController.js
const { runToolLoop } = require("../services/agentEngine/toolLoop");
const { computeCost } = require("../services/agentEngine/modelPricing");
const insightsAgentConfig = require("../services/insightsAgent/insightsAgentConfig");
const { prisma } = require("../lib/prisma");
const { env } = require("../config/env");

const FALLBACK_REPLY =
  "I wasn't able to work that out — try rephrasing, or ask something more specific.";
const MODEL = env.anthropicModelHaiku;

// Fire-and-forget on purpose — a logging failure should never break the
// actual chat response the staff member is waiting on. The insert and the
// StaffUser total run in one transaction so the running total can never
// drift out of sync with the sum of actual InsightsUsage rows.
function logUsage({ staffUserId, question, usage, toolCallLog, outcome }) {
  const cost = computeCost(MODEL, usage);
  console.log(
    `[insights] cost: $${cost.usd.toFixed(6)} / ₹${cost.inr.toFixed(4)} ` +
      `(in=${usage?.inputTokens || 0} out=${usage?.outputTokens || 0} tools=${toolCallLog?.length || 0} outcome=${outcome})`,
  );

  const operations = [
    prisma.insightsUsage.create({
      data: {
        staffUserId: staffUserId || null,
        question,
        model: MODEL,
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
    .then(() => console.log("[insights] usage row saved + staff total updated"))
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

  // Static per-request context, not worth a tool round-trip — req.staffUser
  // is already attached by requireStaffAuth on every request.
  const staffContext = req.staffUser
    ? `\n\nThe staff member you're talking to right now is ${req.staffUser.name} (role: ${req.staffUser.role}). You may greet them by name and answer if they ask who they are — you don't need a tool for that, it's given to you here.`
    : "";
  const systemPrompt = insightsAgentConfig.systemPrompt + staffContext;

  try {
    const result = await runToolLoop({
      systemPrompt,
      tools: insightsAgentConfig.tools,
      toolHandlers: insightsAgentConfig.buildToolHandlers(),
      history: fullHistory,
      maxIterations: env.agentMaxToolIterations || 6,
      // Haiku for now — cheaper while this is still early/internal. Your
      // own modelRouter.js notes Haiku had a ~37% tool-call miss rate on
      // Sales Agent's onboarding flow, so if Insights starts giving
      // wrong/empty answers on questions that clearly should hit a tool,
      // that's the likely cause — swap MODEL above to
      // env.anthropicModelSonnet.
      model: MODEL,
    });

    logUsage({
      staffUserId: req.staffUser?.id,
      question,
      usage: result.usage,
      toolCallLog: result.toolCallLog,
      outcome: result.hitIterationCap ? "iteration_cap" : "completed",
    });

    if (result.hitIterationCap || !result.finalText) {
      return res.json({ reply: FALLBACK_REPLY });
    }

    res.json({ reply: result.finalText });
  } catch (err) {
    console.error("askInsights error:", err);
    logUsage({
      staffUserId: req.staffUser?.id,
      question,
      usage: null,
      toolCallLog: [],
      outcome: "error",
    });
    res.status(500).json({ error: "Insights couldn't process that right now" });
  }
}

module.exports = { askInsights };
