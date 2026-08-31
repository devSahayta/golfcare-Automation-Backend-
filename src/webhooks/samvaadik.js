// src/webhooks/samvaadik.js

const { Router } = require("express");
const express = require("express");
const { prisma } = require("../lib/prisma");
const { resolveConversation } = require("./lib/resolveConversation");
const { runAgent } = require("../services/agentEngine");
const salesAgentConfig = require("../services/salesAgent/salesAgentConfig");
const { sendText, parseWebhook } = require("../lib/samvaadik/adapter");

const router = Router();

// Confirmed real payload shape (captured 27 Aug 2026 via test webhook):
//   [{ event, account_id, from, message, message_type, media_url, timestamp }]
// No signature verification yet — SAMVAADIK_WEBHOOK_SECRET is reserved in
// .env but deliberately not enforced yet, per team decision. Add HMAC
// verification here before this handles real customer traffic in production.
router.use(express.json());

async function handleInboundMessage(evt) {
  // resolveConversation finds/links Customer or Supplier by phone, and
  // creates a bare Customer if neither exists yet (Scenario B — the
  // record needs to exist from message one so search/checkout are never
  // gated on enrollment; enroll_membership fills in the rest later).
  // NOTE: this replaces the previous "never create a Customer here" rule
  // — see conversation with Claude if you need the reasoning again.
  const conversation = await resolveConversation(evt.from);

  // Idempotency guard — Samvaadik (or WhatsApp's own delivery layer)
  // appears to retry webhook delivery if our response is slow, and since
  // we deliberately await the full agent run before responding (see the
  // Vercel-freeze note below), that retry can arrive after the first
  // delivery's lock has already been released, looking like a brand new
  // message and running the whole agent a second time. Same original
  // event redelivered keeps the same `timestamp` field; a genuinely new
  // message from the customer moments later won't. This isn't a perfect
  // key (no message id is available in Samvaadik's forwarded payload as
  // documented) but is a solid practical guard against exact-duplicate
  // redelivery.
  const existingDuplicate = await prisma.message.findFirst({
    where: {
      conversationId: conversation.id,
      direction: "INBOUND",
      body: evt.message,
      createdAt: evt.timestamp,
    },
  });
  if (existingDuplicate) {
    console.log(
      `[samvaadik webhook] duplicate delivery detected for ${conversation.id}, skipping.`,
    );
    return;
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: evt.timestamp },
  });

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "INBOUND",
      sender: "CUSTOMER",
      type: evt.messageType || "text",
      body: evt.message || null,
      mediaUrl: evt.mediaUrl,
      createdAt: evt.timestamp,
    },
  });

  if (conversation.supplierId) {
    // Supplier Agent isn't built yet (Module 5) — leave supplier
    // conversations untouched for now.
    return;
  }

  // Awaited deliberately, not fire-and-forget — Vercel can freeze the
  // function right after res.send(), same gotcha Module 1 already hit.
  try {
    await runAgent({
      conversationId: conversation.id,
      config: salesAgentConfig,
      sendFn: async ({ conversation: c, text }) => sendText(c.waPhone, text),
    });
  } catch (err) {
    console.error("[samvaadik webhook] runAgent failed:", err);
  }
}

router.post("/", async (req, res) => {
  try {
    const events = parseWebhook(req.body);

    for (const evt of events) {
      if (evt.event !== "message.received") {
        console.warn(
          `[samvaadik webhook] unrecognized event type "${evt.event}", skipping.`,
          evt,
        );
        continue;
      }
      await handleInboundMessage(evt);
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("[samvaadik webhook] error:", err);
    res.status(500).send("error");
  }
});

module.exports = router;
