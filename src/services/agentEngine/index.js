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

// Every path that ends the conversation in AWAITING_HUMAN goes through
// this one place, so the customer is NEVER left in total silence — a
// real, recurring UX problem where guardrail blocks or iteration caps
// would flip state with zero message sent, leaving a long, otherwise-good
// conversation dead-ending with no explanation at all.
async function escalateWithMessage({
  conversationId,
  conversation,
  sendFn,
  action,
  before,
  after,
  customerMessage,
}) {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { state: "AWAITING_HUMAN" },
  });
  await logAudit({ action, conversationId, before, after });
  await sendFn({
    conversation,
    text:
      customerMessage ||
      "One sec — let me get someone from our team to jump in here and make sure you're looked after properly. They'll be with you shortly! 🙌",
  }).catch(() => {});
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

    if (history.length === 0 || history[history.length - 1].role !== "user") {
      console.log(
        `[agentEngine] ${conversationId} no new user turn to respond to, skipping.`,
      );
      return { skipped: true, reason: "no_new_user_message" };
    }

    const toolHandlers = config.buildToolHandlers(context);

    async function attempt(extraSystemNote) {
      const promptForThisAttempt = extraSystemNote
        ? `${systemPrompt}\n\n${extraSystemNote}`
        : systemPrompt;
      return runToolLoop({
        systemPrompt: promptForThisAttempt,
        tools: config.tools,
        toolHandlers,
        history,
        maxIterations: env.agentMaxToolIterations,
      });
    }

    let { finalText, toolCallLog, hitIterationCap } = await attempt();

    if (hitIterationCap) {
      await escalateWithMessage({
        conversationId,
        conversation: context.conversation,
        sendFn,
        action: "agent_escalated_iteration_cap",
        after: { toolCallLog },
      });
      return { escalated: true, reason: "iteration_cap" };
    }

    let guardrailResult = runGuardrails({
      draftText: finalText,
      toolCallLog,
      context,
    });

    // Self-heal: give the model ONE honest retry, telling it exactly why
    // its draft was rejected, before ever escalating. Most guardrail
    // blocks today have been false positives in specific phrasing (a
    // generic "in stock" phrase, a clarifying question with bold text,
    // revealing something a beat too early) — not genuine mistakes. A
    // model told the precise reason can usually just rephrase and pass.
    // This recovers automatically from that whole class of issue instead
    // of needing a new hand-written rule every time a new phrasing trips
    // the same underlying concern.
    if (guardrailResult.action === "block") {
      console.log(
        `[agentEngine] ${conversationId} guardrail blocked (${guardrailResult.reason}), retrying once.`,
      );
      const retryNote = `IMPORTANT: your previous draft reply was rejected by an internal check for this reason: "${guardrailResult.reason}". Do not repeat that exact issue — revise your response to avoid it while still genuinely answering the customer's last message. If it was about naming a product or price without a fresh lookup, call the right tool first. If it was about revealing something prematurely, hold off on that specific detail this turn.`;
      const retry = await attempt(retryNote);
      finalText = retry.finalText;
      toolCallLog = retry.toolCallLog;

      if (retry.hitIterationCap) {
        await escalateWithMessage({
          conversationId,
          conversation: context.conversation,
          sendFn,
          action: "agent_escalated_iteration_cap",
          after: { toolCallLog, afterGuardrailRetry: true },
        });
        return { escalated: true, reason: "iteration_cap_after_retry" };
      }

      guardrailResult = runGuardrails({
        draftText: finalText,
        toolCallLog,
        context,
      });
    }

    if (guardrailResult.action === "block") {
      // Still blocked after one genuine retry — this is a real escalation
      // now, not a phrasing hiccup. Customer still gets a warm message,
      // never silence.
      await escalateWithMessage({
        conversationId,
        conversation: context.conversation,
        sendFn,
        action: "agent_response_blocked",
        before: { draftText: finalText },
        after: { reason: guardrailResult.reason, toolCallLog, retried: true },
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
