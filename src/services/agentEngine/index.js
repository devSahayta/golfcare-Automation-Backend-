const { prisma } = require("../../lib/prisma");
const { env } = require("../../config/env");
const { assembleContext } = require("./contextAssembler");
const { runToolLoop } = require("./toolLoop");
const { runGuardrails: runDefaultGuardrails } = require("./guardrails");
const { logMessage, logAudit, logUsage } = require("./logger");
const { pickModel } = require("./modelRouter"); // NEW

// Kept exactly as before — still the fallback rate for any model not
// found in MODEL_RATES below (e.g. if env.anthropicModel is set to
// something not equal to either Sonnet or Haiku's configured string).
const COST_INPUT_USD_PER_MTOK = 3;
const COST_OUTPUT_USD_PER_MTOK = 15;
const USD_TO_INR = 95;

// NEW — per-model rates, needed because a single conversation can now
// mix Sonnet and Haiku calls (initial attempt on one model, guardrail
// retry forced onto Sonnet). Keyed by the actual model string so it
// stays correct even if env vars change which literal model name each
// tier points to.
const MODEL_RATES = {
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  [env.anthropicModelSonnet]: { input: 3, output: 15 },
  [env.anthropicModelHaiku]: { input: 1, output: 5 },
};

function estimateCostInr(usage) {
  // Unchanged — kept as-is for any caller still using the old single-
  // rate estimate (e.g. Supplier Agent, if it doesn't pass a model).
  if (!usage) return null;
  const inputCost = (usage.inputTokens / 1_000_000) * COST_INPUT_USD_PER_MTOK;
  const outputCost =
    (usage.outputTokens / 1_000_000) * COST_OUTPUT_USD_PER_MTOK;
  const usd = inputCost + outputCost;
  return { usd, inr: usd * USD_TO_INR };
}

function estimateCostForModel(usage, model) {
  if (!usage) return null;
  const rates = MODEL_RATES[model] || {
    input: COST_INPUT_USD_PER_MTOK,
    output: COST_OUTPUT_USD_PER_MTOK,
  };
  const inputCost = (usage.inputTokens / 1_000_000) * rates.input;
  const outputCost = (usage.outputTokens / 1_000_000) * rates.output;
  // NEW — cache writes cost 1.25x normal input rate, cache reads cost
  // 0.1x normal input rate. Both were previously untracked entirely,
  // meaning logged cost understated the real Anthropic bill.
  const cacheWriteCost =
    ((usage.cacheCreationTokens || 0) / 1_000_000) * rates.input * 1.25;
  const cacheReadCost =
    ((usage.cacheReadTokens || 0) / 1_000_000) * rates.input * 0.1;
  const usd = inputCost + outputCost + cacheWriteCost + cacheReadCost;
  return { usd, inr: usd * USD_TO_INR };
}

function addUsage(a, b) {
  return {
    inputTokens: (a?.inputTokens || 0) + (b?.inputTokens || 0),
    outputTokens: (a?.outputTokens || 0) + (b?.outputTokens || 0),
  };
}

// NEW — sums two cost objects, same spirit as addUsage above. Needed
// because Sonnet and Haiku costs must be added at THEIR OWN rates, not
// summed as raw tokens and priced once at the end (that would silently
// mis-price whichever model didn't match).
function addCost(a, b) {
  return {
    usd: (a?.usd || 0) + (b?.usd || 0),
    inr: (a?.inr || 0) + (b?.inr || 0),
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
    .catch(() => {});
}

// NEW — increments Conversation.totalCostUsd/totalCostInr atomically via
// Prisma's `increment`, so concurrent turns (shouldn't happen thanks to
// the lock, but defensive anyway) never clobber each other's totals.
// Best-effort like releaseLock — never let this throw past the turn
// that already succeeded and already sent a reply to the customer.
async function addToConversationTotal(conversationId, cost) {
  if (!cost) return;
  await prisma.conversation
    .update({
      where: { id: conversationId },
      data: {
        totalCostUsd: { increment: cost.usd },
        totalCostInr: { increment: cost.inr },
      },
    })
    .catch((err) => {
      console.error(
        "[agentEngine] failed to update conversation totalCost:",
        err.message,
      );
    });
}

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

  const fallbackText =
    customerMessage ||
    "One sec — let me get someone from our team to jump in here and make sure you're looked after properly. They'll be with you shortly! 🙌";

  await sendFn({ conversation, text: fallbackText }).catch(() => {});

  // NEW — this fallback message actually goes out to the customer on
  // WhatsApp via sendFn above, but was never being written to Message,
  // leaving a silent gap in the conversation history right where an
  // escalation happened. Logged as its own OUTBOUND/AI_AGENT row, same
  // shape as a normal sent reply, so the Message table stays a complete
  // record of what the customer actually saw.
  await logMessage({
    conversationId,
    direction: "OUTBOUND",
    sender: "AI_AGENT",
    body: fallbackText,
    toolCalls: [],
  }).catch((err) => {
    console.error(
      "[agentEngine] failed to log escalation fallback message:",
      err.message,
    );
  });
}

async function runAgent({ conversationId, config, sendFn }) {
  const gotLock = await acquireLock(conversationId);
  if (!gotLock) {
    console.log(`[agentEngine] ${conversationId} already processing, skipped.`);
    return { skipped: true, reason: "locked" };
  }

  try {
    const context = await assembleContext({ conversationId });

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
      console.log(
        `[agentEngine] ${conversationId} state=${context.conversation.state}, agent not invoked.`,
      );
      return { skipped: true, reason: "not_ai_handling" };
    }

    const systemPrompt = config.buildSystemPrompt(context);
    const rawHistory = context.recentMessages
      .filter((m) => m.sender !== "SYSTEM" || m.body)
      .map((m) => ({
        role: m.sender === "CUSTOMER" ? "user" : "assistant",
        content: m.body || "",
      }));

    const history = [];
    for (const turn of rawHistory) {
      const last = history[history.length - 1];
      if (last && last.role === turn.role) {
        last.content = `${last.content}\n${turn.content}`.trim();
      } else {
        history.push({ ...turn });
      }
    }

    if (history.length === 0 || history[history.length - 1].role !== "user") {
      console.log(
        `[agentEngine] ${conversationId} no new user turn to respond to, skipping.`,
      );
      return { skipped: true, reason: "no_new_user_message" };
    }

    const toolHandlers = config.buildToolHandlers(context);
    const agentName = config.agentName || context.participantType || "unknown";

    // NEW — decide which model handles this turn's initial attempt,
    // using the context phase + the customer's latest message. Cheap,
    // synchronous, no extra API call.
    const lastUserMessage = history[history.length - 1].content;
    const initialModel = pickModel({ context, lastUserMessage });

    async function attempt(extraSystemNote, model) {
      const promptForThisAttempt = extraSystemNote
        ? `${systemPrompt}\n\n${extraSystemNote}`
        : systemPrompt;
      return runToolLoop({
        systemPrompt: promptForThisAttempt,
        tools: config.tools,
        toolHandlers,
        history,
        maxIterations: env.agentMaxToolIterations,
        model, // NEW
      });
    }

    let { finalText, toolCallLog, hitIterationCap, usage } = await attempt(
      undefined,
      initialModel,
    );
    let totalUsage = usage;
    let totalCost = estimateCostForModel(usage, initialModel); // NEW — replaces the old single estimateCostInr(totalUsage) call
    let lastModelUsed = initialModel; // NEW — tracked for logUsage's model column

    // NEW — safety net for the specific gap found in testing: during
    // Part A enrolment, Haiku sometimes replies conversationally to an
    // onboarding answer ("Got it — weekly") WITHOUT actually calling
    // record_profile_answer, even though the system prompt explicitly
    // instructs "call record_profile_answer right after each answer."
    // The customer sees a confirmation, but nothing gets written to
    // OnboardingResponse — a silent, customer-facing false confirmation
    // that stays invisible until someone checks the DB. If the customer
    // goes quiet before the next guardrail-triggered retry happens to
    // repair it (as it did in testing, only by coincidence), that
    // answer is lost for good. This check catches it immediately
    // instead of relying on luck.
    const missedProfileAnswer =
      initialModel === env.anthropicModelHaiku &&
      context.enrolmentPending &&
      !hitIterationCap &&
      !toolCallLog.some((c) => c.tool === "record_profile_answer");

    if (missedProfileAnswer) {
      console.log(
        `[agentEngine] ${conversationId} Haiku skipped record_profile_answer during enrolment — forcing Sonnet retry.`,
      );
      const repairNote = `IMPORTANT: the customer just answered an enrolment setup question, but your previous draft did not call record_profile_answer to save it. You MUST call record_profile_answer with the correct fieldKey for the question you just asked and the answer the customer just gave, THEN continue with your reply (asking the next question, or closing out if this was the last one). Do not skip the tool call again.`;
      const repairModel = pickModel({
        context,
        lastUserMessage,
        forceStrong: true, // always Sonnet for this repair pass
      });
      const repair = await attempt(repairNote, repairModel);
      finalText = repair.finalText;
      toolCallLog = repair.toolCallLog;
      hitIterationCap = repair.hitIterationCap;
      totalUsage = addUsage(totalUsage, repair.usage);
      totalCost = addCost(
        totalCost,
        estimateCostForModel(repair.usage, repairModel),
      );
      lastModelUsed = repairModel;
    }

    if (hitIterationCap) {
      // UPDATED — no longer flips the conversation to AWAITING_HUMAN.
      // Hitting the iteration cap usually means the model got stuck
      // retrying the same tool call rather than a case that genuinely
      // needs a human (those still go through escalate_to_human, which
      // is unaffected by this change). Handing off to a human for this
      // is overkill: the customer just gets a slightly generic reply
      // this one turn, and the conversation carries on normally in
      // AI_HANDLING — no separate "someone will get back to you" message,
      // no state change, no auto-resume dance needed on their next
      // message.
      console.log(
        `[agentEngine] ${conversationId} hit iteration cap — sending a graceful fallback reply, staying in AI_HANDLING (not escalating to human).`,
      );
      await logUsage({
        conversationId,
        agentName,
        model: lastModelUsed,
        inputTokens: totalUsage?.inputTokens,
        outputTokens: totalUsage?.outputTokens,
        costUsd: totalCost?.usd,
        costInr: totalCost?.inr,
        toolCallCount: toolCallLog.length,
        outcome: "recovered_iteration_cap",
      });
      await addToConversationTotal(conversationId, totalCost);

      const fallbackText =
        "Sorry, got a bit tangled up there! Could you tell me that again in a slightly different way?";
      await sendFn({
        conversation: context.conversation,
        text: fallbackText,
      }).catch(() => {});
      await logMessage({
        conversationId,
        direction: "OUTBOUND",
        sender: "AI_AGENT",
        body: fallbackText,
        toolCalls: toolCallLog,
      }).catch((err) => {
        console.error(
          "[agentEngine] failed to log iteration-cap fallback message:",
          err.message,
        );
      });

      return {
        sent: true,
        text: fallbackText,
        toolCallLog,
        usage: totalUsage,
        recoveredFromCap: true,
      };
    }

    const guardrailFn = config.runGuardrails || runDefaultGuardrails;
    let guardrailResult = guardrailFn({
      draftText: finalText,
      toolCallLog,
      context,
    });

    if (guardrailResult.action === "block") {
      console.log(
        `[agentEngine] ${conversationId} guardrail blocked (${guardrailResult.reason}), retrying once.`,
      );
      const retryNote = `IMPORTANT: your previous draft reply was rejected by an internal check for this reason: "${guardrailResult.reason}". Do not repeat that exact issue — revise your response to avoid it while still genuinely answering the customer's last message. If it was about naming a product or price without a fresh lookup, call the right tool first. If it was about revealing something prematurely, hold off on that specific detail this turn.`;

      // NEW — the retry always forces the stronger model, regardless of
      // what the initial attempt used. A draft was already rejected
      // once; don't risk the same mistake on the cheaper model.
      const retryModel = pickModel({
        context,
        lastUserMessage,
        forceStrong: true,
      });
      const retry = await attempt(retryNote, retryModel);
      finalText = retry.finalText;
      toolCallLog = retry.toolCallLog;
      totalUsage = addUsage(totalUsage, retry.usage);
      totalCost = addCost(
        totalCost,
        estimateCostForModel(retry.usage, retryModel),
      ); // NEW
      lastModelUsed = retryModel; // NEW

      if (retry.hitIterationCap) {
        console.log(
          `[agentEngine] ${conversationId} escalated (iteration_cap_after_retry). ` +
            `${totalUsage?.inputTokens ?? 0} in / ${totalUsage?.outputTokens ?? 0} out tokens` +
            (totalCost
              ? ` (~$${totalCost.usd.toFixed(4)} / ~₹${totalCost.inr.toFixed(2)}).`
              : "."),
        );
        await logUsage({
          conversationId,
          agentName,
          model: lastModelUsed, // NEW
          inputTokens: totalUsage?.inputTokens,
          outputTokens: totalUsage?.outputTokens,
          costUsd: totalCost?.usd,
          costInr: totalCost?.inr,
          toolCallCount: toolCallLog.length,
          outcome: "escalated_iteration_cap_after_retry",
        });
        await addToConversationTotal(conversationId, totalCost); // NEW
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
      // UPDATED — a guardrail block surviving the retry no longer flips
      // the conversation to AWAITING_HUMAN. This was a defensive check
      // catching something risky in the model's own draft (a
      // hallucinated field, a leaked internal term, an unverified
      // claim) — not a situation where a human genuinely needs to step
      // in. The "someone will be in touch" message mid-conversation was
      // reading to customers like the chat had died, right at
      // sensitive moments (e.g. mid-onboarding) — exactly the kind of
      // drop-off this is meant to prevent. Deliberate escalate_to_human
      // TOOL calls the model makes on purpose (high-value orders, a
      // genuinely upset customer) are UNCHANGED — those already don't
      // touch conversation.state at all (see salesAgentTools.js's
      // escalate_to_human handler). This block covers only the
      // guardrail's own internal safety catches, which should never be
      // a customer-facing dead end.
      console.log(
        `[agentEngine] ${conversationId} guardrail still blocked after retry (${guardrailResult.reason}) — sending a graceful fallback reply, staying in AI_HANDLING.`,
      );
      await logAudit({
        action: "agent_response_blocked_recovered",
        conversationId,
        before: { draftText: finalText },
        after: { reason: guardrailResult.reason, toolCallLog, retried: true },
      });
      await logUsage({
        conversationId,
        agentName,
        model: lastModelUsed,
        inputTokens: totalUsage?.inputTokens,
        outputTokens: totalUsage?.outputTokens,
        costUsd: totalCost?.usd,
        costInr: totalCost?.inr,
        toolCallCount: toolCallLog.length,
        outcome: `recovered_${guardrailResult.reason}`,
      });
      await addToConversationTotal(conversationId, totalCost);

      const fallbackText =
        "Sorry, got a bit tangled up there! Could you tell me that again in a slightly different way?";
      await sendFn({
        conversation: context.conversation,
        text: fallbackText,
      }).catch(() => {});
      await logMessage({
        conversationId,
        direction: "OUTBOUND",
        sender: "AI_AGENT",
        body: fallbackText,
        toolCalls: toolCallLog,
      }).catch((err) => {
        console.error(
          "[agentEngine] failed to log guardrail fallback message:",
          err.message,
        );
      });

      return {
        sent: true,
        text: fallbackText,
        toolCallLog,
        usage: totalUsage,
        recoveredFromGuardrailBlock: true,
      };
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
      `[agentEngine] ${conversationId} sent reply (${toolCallLog.length} tool call(s)). ` +
        `${totalUsage?.inputTokens ?? 0} in / ${totalUsage?.outputTokens ?? 0} out tokens` +
        (totalCost
          ? ` (~$${totalCost.usd.toFixed(4)} / ~₹${totalCost.inr.toFixed(2)} this turn, model=${lastModelUsed}).`
          : "."),
    );
    await logUsage({
      conversationId,
      agentName,
      model: lastModelUsed, // NEW
      inputTokens: totalUsage?.inputTokens,
      outputTokens: totalUsage?.outputTokens,
      costUsd: totalCost?.usd,
      costInr: totalCost?.inr,
      toolCallCount: toolCallLog.length,
      outcome: "sent",
    });
    await addToConversationTotal(conversationId, totalCost); // NEW

    return { sent: true, text: finalText, toolCallLog, usage: totalUsage };
  } finally {
    await releaseLock(conversationId);
  }
}

module.exports = { runAgent };
