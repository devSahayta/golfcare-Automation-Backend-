// src/lib/resolveCustomerConversationForSend.js
//
// Proactive-send counterpart to webhooks/lib/resolveConversation.js. That
// file is for an INBOUND message — it always refreshes sessionExpiresAt
// to a fresh 24h window, because an inbound message IS what opens/renews
// WhatsApp's real messaging window. This file is for US initiating contact
// (a membership-invite template, right after an order syncs) — mirrors
// golfcare-scheduler's src/lib/resolveCustomerConversation.js exactly
// (cross-repo duplication, same convention already used throughout this
// codebase — see e.g. src/lib/samvaadik/adapter.js's own header comment):
// find an existing non-expired-session conversation, or create one with
// sessionExpiresAt: null. A proactive send does NOT open Meta's 24h
// free-text window by itself — only the customer's own reply does that,
// which the inbound webhook (resolveConversation.js) already handles.

const { prisma } = require("../lib/prisma");

async function resolveCustomerConversationForSend(customer) {
  const existing = await prisma.conversation.findFirst({
    where: {
      customerId: customer.id,
      OR: [
        { sessionExpiresAt: null },
        { sessionExpiresAt: { gt: new Date() } },
      ],
    },
    orderBy: { lastMessageAt: "desc" },
  });
  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      customerId: customer.id,
      waPhone: customer.waPhone,
      state: "AI_HANDLING",
      lastMessageAt: new Date(),
      sessionExpiresAt: null,
    },
  });
}

module.exports = { resolveCustomerConversationForSend };
