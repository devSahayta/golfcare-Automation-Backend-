// src/services/agentEngine/logger.js
const { prisma } = require("../../lib/prisma");

async function logMessage({
  conversationId,
  direction,
  sender,
  type = "text",
  body,
  toolCalls,
  waMessageId,
}) {
  return prisma.message.create({
    data: {
      conversationId,
      direction,
      sender,
      type,
      body: body || null,
      toolCalls: toolCalls || null,
      waMessageId: waMessageId || null,
    },
  });
}

async function logAudit({ action, conversationId, before, after }) {
  return prisma.auditLog.create({
    data: {
      actorType: "AGENT",
      action,
      entityType: "Conversation",
      entityId: conversationId,
      beforeState: before || null,
      afterState: after || null,
      source: "agent_engine",
    },
  });
}

// NEW — one row per agent turn, so real cost can be queried with SQL
// (SUM by conversationId, by day, by outcome, etc.) instead of only
// existing as console.log lines. usage/cost come from toolLoop.js's real
// response.usage tracking via agentEngine/index.js — never invented here,
// this function just persists what it's given. Failure to write a usage
// row should never break the actual conversation flow (the customer
// already got their reply by the time this is called), so this
// deliberately swallows its own errors rather than throwing — same
// best-effort spirit as releaseLock in index.js.
async function logUsage({
  conversationId,
  agentName,
  inputTokens,
  outputTokens,
  costUsd,
  costInr,
  toolCallCount,
  outcome,
}) {
  return prisma.agentUsage
    .create({
      data: {
        conversationId,
        agentName: agentName || "unknown",
        inputTokens: inputTokens || 0,
        outputTokens: outputTokens || 0,
        costUsd: costUsd || 0,
        costInr: costInr || 0,
        toolCallCount: toolCallCount || 0,
        outcome,
      },
    })
    .catch((err) => {
      console.error("[logger] logUsage failed:", err.message);
      return null;
    });
}

module.exports = { logMessage, logAudit, logUsage };
