// src/services/agentEngine/messageDebouncer.js
//
// Batches rapid consecutive inbound messages from the same conversation
// into a single runAgent() invocation. Awaits its own debounce wait as
// part of the same promise chain waitUntil() already holds open (does
// NOT use a bare setTimeout callback fired later — that breaks on
// Vercel serverless, same bug class as forwardToApiWebhooks earlier).

const { env } = require("../../config/env");
const { prisma } = require("../../lib/prisma");
const { runAgent } = require("./index");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithLockRetry(
  { conversationId, config, sendFn },
  attemptsLeft = 4,
) {
  const result = await runAgent({ conversationId, config, sendFn });
  if (result?.skipped && result.reason === "locked" && attemptsLeft > 0) {
    await sleep(2000);
    return runWithLockRetry(
      { conversationId, config, sendFn },
      attemptsLeft - 1,
    );
  }
  return result;
}

async function scheduleAgentRun({ conversationId, messageId, config, sendFn }) {
  await sleep(env.agentMessageDebounceMs);

  const latest = await prisma.message.findFirst({
    where: { conversationId, direction: "INBOUND" },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  if (!latest || latest.id !== messageId) {
    console.log(
      `[messageDebouncer] ${conversationId} superseded by a newer message — skipping.`,
    );
    return { skipped: true, reason: "superseded" };
  }

  return runWithLockRetry({ conversationId, config, sendFn });
}

module.exports = { scheduleAgentRun };
