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
const { runGuardrails: runDefaultGuardrails } = require("./guardrails");
const { logMessage, logAudit, logUsage } = require("./logger");

// Cost-estimate constants — ONLY used to print an approximate $/₹ figure
// next to the real, exact token counts in the log line below. The token
// counts themselves (from toolLoop.js's usage tracking, which reads the
// actual response.usage the Anthropic API returns on every call) are the
// real, authoritative numbers; this conversion is just a convenience so
// nobody has to do the math by hand from the logs every time. Update
// these two rates if the model changes or Anthropic's pricing changes —
// current as of Sept 2026 for Claude Sonnet 4.6 ($3/$15 per million
// input/output tokens). USD_TO_INR is a rough static rate, not fetched
// live — good enough for a ballpark next to real token counts, not
// intended as a billing-accurate conversion.
const COST_INPUT_USD_PER_MTOK = 3;
const COST_OUTPUT_USD_PER_MTOK = 15;
const USD_TO_INR = 95;

function estimateCostInr(usage) {
  if (!usage) return null;
  const inputCost = (usage.inputTokens / 1_000_000) * COST_INPUT_USD_PER_MTOK;
  const outputCost =
    (usage.outputTokens / 1_000_000) * COST_OUTPUT_USD_PER_MTOK;
  const usd = inputCost + outputCost;
  return { usd, inr: usd * USD_TO_INR };
}

// Sums usage across every attempt() call made for a single runAgent()
// invocation — the initial attempt PLUS a guardrail self-heal retry if
// one happened. A retry is a real, separately-billed Anthropic call (it
// re-sends the system prompt + full history again, same as any other
// iteration), so it must be counted too — logging only the final
// attempt's usage would understate the true cost of any conversation
// that needed a retry.
function addUsage(a, b) {
  return {
    inputTokens: (a?.inputTokens || 0) + (b?.inputTokens || 0),
    outputTokens: (a?.outputTokens || 0) + (b?.outputTokens || 0),
  };
}

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

    // AWAITING_HUMAN means "flagged for review" — it is NOT the same as
    // HUMAN_HANDLING (a staff member has actually taken over). The AI
    // should never go permanently silent just because something was
    // flagged at some earlier point; the moment the customer sends
    // anything new, resume automatically so they always get a live
    // response. The flag itself is preserved in AuditLog for staff to
    // review whenever they get to it — this doesn't lose that signal,
    // it just stops it from freezing the conversation.
    if (context.conversation.state === "AWAITING_HUMAN") {
      await prisma.conversation.update({
        where: { id: conversationId },
        data: { state: "AI_HANDLING" },
      });
      context.conversation.state = "AI_HANDLING";
      console.log(
        `[agentEngine] ${conversationId} auto-resumed from AWAITING_HUMAN.`,
      );
    } else if (context.conversation.state !== "AI_HANDLING") {
      // HUMAN_HANDLING or CLOSED — a real person is genuinely handling
      // this, or the conversation is done. Never auto-override either.
      console.log(
        `[agentEngine] ${conversationId} state=${context.conversation.state}, agent not invoked.`,
      );
      return { skipped: true, reason: "not_ai_handling" };
    }

    const systemPrompt = config.buildSystemPrompt(context);
    // Module 5's check-in dispatch logs the WhatsApp template send itself
    // as a Message row (sender: "SYSTEM", body: null) purely for an audit
    // trail — it was never meant to become a turn in the model's own
    // conversation history. Left in, `m.body || ""` turns each one into an
    // empty-content "assistant" turn; a run of those right before the
    // supplier's reply gives the model nothing indicating a check-in went
    // out at all (confirmed live: a bare "yes"/"Okay" reply got a generic
    // reply instead of the itemized list — the pendingCheck system-prompt
    // section was correct, but the empty turns immediately before it in
    // history were pure noise). Filtered out here rather than given
    // placeholder text, since the pendingCheck section already tells the
    // model everything it needs about what was sent and what's pending.
    const history = context.recentMessages
      .filter((m) => m.sender !== "SYSTEM" || m.body)
      .map((m) => ({
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

    // Which agent ran this turn, for AgentUsage cost tracking. Prefers an
    // explicit config.agentName (see salesAgentConfig.js) — falls back to
    // context.participantType (CUSTOMER/SUPPLIER/UNKNOWN, already computed
    // generically in contextAssembler.js for every conversation) so this
    // still works correctly even for agent configs that haven't added
    // their own agentName yet, e.g. the current supplierAgentConfig.js.
    const agentName = config.agentName || context.participantType || "unknown";

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

    let { finalText, toolCallLog, hitIterationCap, usage } = await attempt();
    let totalUsage = usage;

    if (hitIterationCap) {
      const cost = estimateCostInr(totalUsage);
      console.log(
        `[agentEngine] ${conversationId} escalated (iteration_cap). ` +
          `${totalUsage?.inputTokens ?? 0} in / ${totalUsage?.outputTokens ?? 0} out tokens` +
          (cost
            ? ` (~$${cost.usd.toFixed(4)} / ~₹${cost.inr.toFixed(2)}).`
            : "."),
      );
      await logUsage({
        conversationId,
        agentName,
        inputTokens: totalUsage?.inputTokens,
        outputTokens: totalUsage?.outputTokens,
        costUsd: cost?.usd,
        costInr: cost?.inr,
        toolCallCount: toolCallLog.length,
        outcome: "escalated_iteration_cap",
      });
      await escalateWithMessage({
        conversationId,
        conversation: context.conversation,
        sendFn,
        action: "agent_escalated_iteration_cap",
        after: { toolCallLog },
      });
      return { escalated: true, reason: "iteration_cap" };
    }

    // Each agent config may register its own guardrail rules (Sales
    // checks price/discount claims, Supplier's is intentionally lean —
    // see their respective guardrails.js/supplierGuardrails.js). Configs
    // that don't provide one fall back to the original Sales-shaped
    // rules, so this stays backward compatible with configs written
    // before runGuardrails was pluggable. Used for both the initial check
    // and the post-retry recheck below, so a config's own rules apply
    // consistently across both passes.
    const guardrailFn = config.runGuardrails || runDefaultGuardrails;
    let guardrailResult = guardrailFn({
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
      // A retry is a real, separately-billed Anthropic call — add its
      // usage to the running total rather than replacing it, so the
      // final logged cost reflects BOTH attempts, not just whichever one
      // happened to end the turn.
      totalUsage = addUsage(totalUsage, retry.usage);

      if (retry.hitIterationCap) {
        const cost = estimateCostInr(totalUsage);
        console.log(
          `[agentEngine] ${conversationId} escalated (iteration_cap_after_retry). ` +
            `${totalUsage?.inputTokens ?? 0} in / ${totalUsage?.outputTokens ?? 0} out tokens` +
            (cost
              ? ` (~$${cost.usd.toFixed(4)} / ~₹${cost.inr.toFixed(2)}).`
              : "."),
        );
        await logUsage({
          conversationId,
          agentName,
          inputTokens: totalUsage?.inputTokens,
          outputTokens: totalUsage?.outputTokens,
          costUsd: cost?.usd,
          costInr: cost?.inr,
          toolCallCount: toolCallLog.length,
          outcome: "escalated_iteration_cap_after_retry",
        });
        await escalateWithMessage({
          conversationId,
          conversation: context.conversation,
          sendFn,
          action: "agent_escalated_iteration_cap",
          after: { toolCallLog, afterGuardrailRetry: true },
        });
        return { escalated: true, reason: "iteration_cap_after_retry" };
      }

      guardrailResult = guardrailFn({
        draftText: finalText,
        toolCallLog,
        context,
      });
    }

    if (guardrailResult.action === "block") {
      // Still blocked after one genuine retry — this is a real escalation
      // now, not a phrasing hiccup. Customer still gets a warm message,
      // never silence.
      const cost = estimateCostInr(totalUsage);
      console.log(
        `[agentEngine] ${conversationId} escalated (${guardrailResult.reason}). ` +
          `${totalUsage?.inputTokens ?? 0} in / ${totalUsage?.outputTokens ?? 0} out tokens` +
          (cost
            ? ` (~$${cost.usd.toFixed(4)} / ~₹${cost.inr.toFixed(2)}).`
            : "."),
      );
      await logUsage({
        conversationId,
        agentName,
        inputTokens: totalUsage?.inputTokens,
        outputTokens: totalUsage?.outputTokens,
        costUsd: cost?.usd,
        costInr: cost?.inr,
        toolCallCount: toolCallLog.length,
        outcome: `escalated_${guardrailResult.reason}`,
      });
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

    // Real cost for THIS turn (not the whole conversation — sum this
    // across every turn in a conversationId to get the true total, e.g.
    // by aggregating these log lines through whatever log pipeline
    // you're already using). inputTokens/outputTokens come straight from
    // toolLoop.js's usage tracking, which reads response.usage on every
    // real Anthropic call this turn made — this is exact, not an
    // estimate. The $/₹ figure next to it IS an estimate (see
    // COST_INPUT_USD_PER_MTOK etc. above) — a fixed conversion applied
    // to a real number, not a guess about the number itself.
    const cost = estimateCostInr(totalUsage);
    console.log(
      `[agentEngine] ${conversationId} sent reply (${toolCallLog.length} tool call(s)). ` +
        `${totalUsage?.inputTokens ?? 0} in / ${totalUsage?.outputTokens ?? 0} out tokens` +
        (cost
          ? ` (~$${cost.usd.toFixed(4)} / ~₹${cost.inr.toFixed(2)} this turn).`
          : "."),
    );
    await logUsage({
      conversationId,
      agentName,
      inputTokens: totalUsage?.inputTokens,
      outputTokens: totalUsage?.outputTokens,
      costUsd: cost?.usd,
      costInr: cost?.inr,
      toolCallCount: toolCallLog.length,
      outcome: "sent",
    });
    return { sent: true, text: finalText, toolCallLog, usage: totalUsage };
  } finally {
    await releaseLock(conversationId);
  }
}

module.exports = { runAgent };
