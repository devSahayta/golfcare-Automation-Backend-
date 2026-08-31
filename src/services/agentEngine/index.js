// src/services/agentEngine/index.js
//
// The one function every entry point calls: runAgent({ conversationId,
// config, sendFn }). This file should never need to change when a new
// agent type (Supplier, Lifecycle, Insights) is added — only `config`
// (systemPrompt/tools/handlers) and the entry point calling this differ.
//
// Locking: WhatsApp can deliver two quick messages before the first
// response finishes. processingLockedAt on Conversation prevents two
// runAgent() calls racing on the same conversation — same bug class as
// Module 1's "finish all DB writes before res.send()" issue. If the lock
// is stale (a prior run crashed mid-way without releasing it), it's
// treated as free after AGENT_PROCESSING_LOCK_STALE_MINUTES.
//
// Requires a schema change: Conversation.processingLockedAt DateTime?
// — see INTEGRATION.md.

const { prisma } = require("../../lib/prisma");
const { env } = require("../../config/env");
const { assembleContext } = require("./contextAssembler");
const { runToolLoop } = require("./toolLoop");
const { runGuardrails } = require("./guardrails");
const { logMessage, logAudit } = require("./logger");

async function acquireLock(conversationId) {
  const staleBefore = new Date(
    Date.now() - env.agentProcessingLockStaleMinutes * 60 * 1000,
  );
  const result = await prisma.conversation.updateMany({
    where: {
      id: conversationId,
      OR: [
        { processingLockedAt: null },
        { processingLockedAt: { lt: staleBefore } },
      ],
    },
    data: { processingLockedAt: new Date() },
  });
  return result.count === 1;
}

async function releaseLock(conversationId) {
  await prisma.conversation
    .update({
      where: { id: conversationId },
      data: { processingLockedAt: null },
    })
    .catch(() => {}); // best-effort — don't let lock release itself throw past a finally
}

/**
 * @param {object} input
 * @param {string} input.conversationId
 * @param {object} input.config - { tools, buildSystemPrompt, buildToolHandlers }
 * @param {(args: {conversation: object, text: string}) => Promise<void>} input.sendFn
 */
async function runAgent({ conversationId, config, sendFn }) {
  const gotLock = await acquireLock(conversationId);
  if (!gotLock) {
    console.log(`[agentEngine] ${conversationId} already processing, skipped.`);
    return { skipped: true, reason: "locked" };
  }

  try {
    const context = await assembleContext({ conversationId });

    if (context.conversation.state !== "AI_HANDLING") {
      console.log(
        `[agentEngine] ${conversationId} state=${context.conversation.state}, agent not invoked.`,
      );
      return { skipped: true, reason: "not_ai_handling" };
    }

    const systemPrompt = config.buildSystemPrompt(context);
    const history = context.recentMessages.map((m) => ({
      role: m.sender === "CUSTOMER" ? "user" : "assistant",
      content: m.body || "",
    }));

    const { finalText, toolCallLog, hitIterationCap } = await runToolLoop({
      systemPrompt,
      tools: config.tools,
      toolHandlers: config.buildToolHandlers(context),
      history,
      maxIterations: env.agentMaxToolIterations,
    });

    if (hitIterationCap) {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { state: "AWAITING_HUMAN" },
      });
      await logAudit({
        action: "agent_escalated_iteration_cap",
        conversationId,
        after: { toolCallLog },
      });
      return { escalated: true, reason: "iteration_cap" };
    }

    const guardrailResult = runGuardrails({
      draftText: finalText,
      toolCallLog,
      context,
    });

    if (guardrailResult.action === "block") {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { state: "AWAITING_HUMAN" },
      });
      await logAudit({
        action: "agent_response_blocked",
        conversationId,
        before: { draftText: finalText },
        after: { reason: guardrailResult.reason, toolCallLog },
      });
      return { escalated: true, reason: guardrailResult.reason };
    }

    await sendFn({ conversation: context.conversation, text: finalText });

    await logMessage({
      conversationId,
      direction: "OUTBOUND",
      sender: "AI_AGENT",
      body: finalText,
      toolCalls: toolCallLog,
    });

    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    console.log(
      `[agentEngine] ${conversationId} sent reply (${toolCallLog.length} tool call(s)).`,
    );
    return { sent: true, text: finalText, toolCallLog };
  } finally {
    await releaseLock(conversationId);
  }
}

module.exports = { runAgent };
