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

module.exports = { logMessage, logAudit };
