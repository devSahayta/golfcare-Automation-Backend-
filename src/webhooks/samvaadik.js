// src/webhooks/samvaadik.js

const { Router } = require("express");
const express = require("express");
const { waitUntil } = require("@vercel/functions");
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
  console.log(`[samvaadik webhook] inbound message from ${evt.from}:`, evt);
  // const TESTING_ALLOWED_PHONE = "916382592767";
  // if (evt.from !== TESTING_ALLOWED_PHONE) {
  //   console.log(
  //     `[samvaadik webhook] ignoring message from ${evt.from} (testing mode, only ${TESTING_ALLOWED_PHONE} allowed)`,
  //   );
  //   return;
  // }
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
  //
  // UPDATED: this await itself is unchanged and still correct — the
  // Vercel-freeze concern this comment describes is real and still
  // applies. What changed is WHERE this function gets called from: it
  // used to be awaited directly inside router.post's handler, BEFORE
  // res.status(200).send("ok") — meaning Samvaadik's forwarder sat
  // waiting on this entire agent run (one or more Anthropic round trips +
  // tool calls + the actual WhatsApp send) to finish before getting its
  // ack. That easily exceeds Samvaadik's 10s forward timeout, and the
  // resulting retry is exactly what produced the confirmed duplicate
  // delivery in production (996768cb-..., ~12s apart). Now this whole
  // chain runs inside waitUntil() (see router.post below), called AFTER
  // the ack is already sent — so the "await until it's really done"
  // behavior this comment cares about is fully preserved, it just no
  // longer blocks the response Samvaadik is waiting on.

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

// NEW: runs the event loop that used to sit directly inside router.post's
// try block, now called via waitUntil AFTER the response has already been
// sent (see router.post below) instead of before it. Nothing about what
// this loop does has changed — same events, same handleInboundMessage,
// same order — only when it runs relative to the HTTP response.
//
// One small, deliberate improvement bundled in: each event now gets its
// own try/catch instead of one try/catch around the whole loop. Previously,
// if handleInboundMessage threw for the first event in a batch, the loop
// stopped immediately and any remaining events in that same webhook call
// were never processed at all. That was never a behavior anything relied
// on (nothing in the code comments suggests "stop on first error" was
// intentional) — it was just an incidental side effect of the try/catch
// being at the wrong scope. Isolating per-event also matters more now
// than before: with the response already sent, there's no res.status(500)
// left to signal a failure anyway, so silently dropping the rest of a
// batch over one bad event would be a pure loss with no compensating
// benefit.
async function processEventsInBackground(events) {
  for (const evt of events) {
    if (evt.event !== "message.received") {
      console.warn(
        `[samvaadik webhook] unrecognized event type "${evt.event}", skipping.`,
        evt,
      );
      continue;
    }
    try {
      await handleInboundMessage(evt);
    } catch (err) {
      // Previously this error would propagate up to router.post's outer
      // catch, which responded res.status(500) — that response no longer
      // exists to send by the time this runs, since the ack already went
      // out before this function was even called. Logging is correct
      // here: Samvaadik already has its 200, and a 500 at this point
      // wouldn't reach anyone meaningfully anyway.
      console.error("[samvaadik webhook] error handling event:", err);
    }
  }
}

router.post("/", async (req, res) => {
  let events;
  try {
    events = parseWebhook(req.body);
  } catch (err) {
    // Parsing the payload itself is fast, synchronous work and can still
    // fail before we know whether there's anything valid to process at
    // all — this stays exactly as it was: a real error here still gets a
    // real 500 response, unchanged from before.
    console.error("[samvaadik webhook] error:", err);
    return res.status(500).send("error");
  }

  // ── THE ACTUAL FIX ──────────────────────────────────────────────────────
  // Payload is parsed and valid — nothing that follows needs to complete
  // before Samvaadik gets its 200, so ack now and run the real processing
  // (including the full agent turn per event) via waitUntil(), same
  // pattern already applied to Samvaadik's own whatsappController.js.
  // waitUntil specifically (not just "don't await") is required because
  // this also runs on Vercel serverless — without it, Vercel can freeze
  // this function shortly after the response is sent, which is exactly
  // the failure mode the original "awaited deliberately" comment above
  // was trying to avoid. waitUntil keeps the instance alive until
  // processEventsInBackground's promise settles, without holding up the
  // HTTP response itself — so both concerns (don't block the ack, don't
  // get frozen mid-processing) are satisfied at the same time.
  res.status(200).send("ok");
  waitUntil(processEventsInBackground(events));
});

module.exports = router;
