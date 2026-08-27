const { Router } = require("express");
const express = require("express");
const { prisma } = require("../lib/prisma");

const router = Router();

// Confirmed real payload shape (captured 27 Aug 2026 via test webhook):
//   [{ event, account_id, from, message, message_type, media_url, timestamp }]
// No signature verification yet — SAMVAADIK_WEBHOOK_SECRET is reserved in
// .env but deliberately not enforced yet, per team decision. Add HMAC
// verification here before this handles real customer traffic in production.
router.use(express.json());

function normalizeEvents(body) {
  const events = Array.isArray(body) ? body : [body];
  return events.map((evt) => ({
    event: evt.event,
    accountId: evt.account_id,
    from: evt.from,
    message: evt.message,
    messageType: evt.message_type,
    mediaUrl: evt.media_url || null,
    timestamp: evt.timestamp ? new Date(evt.timestamp) : new Date(),
  }));
}

async function handleInboundMessage(evt) {
  // Find or link a Customer by phone, if one already exists — never
  // create a new Customer here, same rule as the Shopify order/customer
  // sync: Customer creation is owned by the WhatsApp onboarding flow
  // elsewhere in the system, not by this webhook.
  const customer = await prisma.customer.findUnique({
    where: { waPhone: evt.from },
    select: { id: true },
  });

  // Find the most recent conversation for this phone number, or start one.
  let conversation = await prisma.conversation.findFirst({
    where: { waPhone: evt.from },
    orderBy: { createdAt: "desc" },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        waPhone: evt.from,
        customerId: customer?.id || null,
        state: "AI_HANDLING",
        lastMessageAt: evt.timestamp,
      },
    });
  } else {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: evt.timestamp,
        ...(customer?.id &&
          !conversation.customerId && { customerId: customer.id }),
      },
    });
  }

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
}

router.post("/", async (req, res) => {
  try {
    const events = normalizeEvents(req.body);

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
