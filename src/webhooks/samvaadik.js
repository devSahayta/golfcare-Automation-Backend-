// src/webhooks/samvaadik.js

const { Router } = require("express");
const express = require("express");
const { prisma } = require("../lib/prisma");
const { resolveConversation } = require("./lib/resolveConversation");
const { runAgent } = require("../services/agentEngine");
const salesAgentConfig = require("../services/salesAgent/salesAgentConfig");
const supplierAgentConfig = require("../services/supplierAgent/supplierAgentConfig");
const {
  sendText,
  parseWebhook,
  downloadMedia,
} = require("../lib/samvaadik/adapter");
const { extractTextFromDocument } = require("../services/documentExtractor");

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
  // message and running the whole agent a second time.
  //
  // Originally matched on an EXACT timestamp — turned out wrong, confirmed
  // against a real duplicate delivery: the same document arrived twice
  // with the same mediaUrl but timestamps 0.48s apart and different
  // message_type values ("pdf" then "document"). An exact match never
  // catches that, so both deliveries got fully processed — this is what
  // actually caused a cascade of double tool calls in a real conversation
  // (duplicate reconcile_stock_list/create_product_draft calls). Widened
  // to a short window instead of an exact match.
  //
  // Matched on mediaUrl rather than body for attachments — body ends up
  // holding the extracted document text (see below), not evt.message, so
  // comparing against evt.message would never match a real duplicate.
  const DEDUP_WINDOW_MS = 15000;
  const dedupWindow = {
    gte: new Date(new Date(evt.timestamp).getTime() - DEDUP_WINDOW_MS),
    lte: new Date(new Date(evt.timestamp).getTime() + DEDUP_WINDOW_MS),
  };
  const existingDuplicate = await prisma.message.findFirst({
    where: evt.mediaUrl
      ? {
          conversationId: conversation.id,
          direction: "INBOUND",
          mediaUrl: evt.mediaUrl,
          createdAt: dedupWindow,
        }
      : {
          conversationId: conversation.id,
          direction: "INBOUND",
          body: evt.message,
          createdAt: dedupWindow,
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

  // A supplier's stock sheet/PDF arrives as an attachment, not typed text.
  // Extract it to plain text once, here, so it becomes a normal-looking
  // Message.body and needs no special handling anywhere downstream (see
  // documentExtractor.js's header for why). Detection is by the file's
  // own content, not Samvaadik's message_type field — no attachment value
  // of that field has ever been documented in this codebase.
  let body = evt.message || null;
  let detectedFormat = null;
  if (evt.mediaUrl) {
    try {
      const fileBuffer = await downloadMedia(evt.mediaUrl);
      const extracted = await extractTextFromDocument(fileBuffer);
      detectedFormat = extracted.ok ? extracted.format : null;
      if (extracted.ok && extracted.format === "image") {
        // No text to extract from a photo — module 5.2's onboarding flow
        // uses Message.mediaUrl (already stored below) directly instead.
        const caption = evt.message ? `${evt.message}\n\n` : "";
        body = `${caption}[Supplier sent an image attachment]`;
      } else if (extracted.ok) {
        const caption = evt.message ? `${evt.message}\n\n` : "";
        body = `${caption}[Attached file — extracted contents below]\n\n${extracted.text}`;
      } else {
        body = `${evt.message ? `${evt.message}\n\n` : ""}[Supplier sent an attachment that couldn't be read: ${extracted.reason}]`;
      }
    } catch (err) {
      console.error(
        `[samvaadik webhook] attachment download/extraction failed for ${conversation.id}:`,
        err.message,
      );
      body = `${evt.message ? `${evt.message}\n\n` : ""}[Supplier sent an attachment that couldn't be downloaded]`;
    }
  }

  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      direction: "INBOUND",
      sender: "CUSTOMER",
      // Our own detection wins when it fired — Samvaadik's message_type
      // has no documented values for attachments (see the comment
      // above), so it isn't reliable enough to gate on downstream (e.g.
      // module 5.2 picking "the most recent actual photo" for a product
      // draft — it needs this to be accurate, not just whatever Samvaadik
      // happened to send).
      type: detectedFormat || evt.messageType || "text",
      body,
      mediaUrl: evt.mediaUrl,
      createdAt: evt.timestamp,
    },
  });

  const config = conversation.supplierId
    ? supplierAgentConfig
    : salesAgentConfig;

  // Awaited deliberately, not fire-and-forget — Vercel can freeze the
  // function right after res.send(), same gotcha Module 1 already hit.
  try {
    await runAgent({
      conversationId: conversation.id,
      config,
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
