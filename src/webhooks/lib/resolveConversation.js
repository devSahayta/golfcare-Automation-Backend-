// src/webhooks/lib/resolveConversation.js
//
// Finds an open (non-expired-session) Conversation for this waPhone, or
// creates one. Checks Customer first (higher-volume path), then Supplier.
// An unknown number defaults to CUSTOMER — the overwhelmingly common
// case — rather than silently dropping a legitimate first-time buyer.

const { prisma } = require("../../lib/prisma");

const SESSION_HOURS = 24; // matches Meta's free-text window

function newConversationData(waPhone, extra) {
  return {
    waPhone,
    state: "AI_HANDLING",
    lastMessageAt: new Date(),
    sessionExpiresAt: new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000),
    ...extra,
  };
}

async function resolveConversation(waPhone) {
  const existing = await prisma.conversation.findFirst({
    where: {
      waPhone,
      OR: [
        { sessionExpiresAt: null },
        { sessionExpiresAt: { gt: new Date() } },
      ],
    },
    orderBy: { lastMessageAt: "desc" },
  });
  if (existing) return existing;

  const customer = await prisma.customer.findUnique({ where: { waPhone } });
  if (customer)
    return prisma.conversation.create({
      data: newConversationData(waPhone, { customerId: customer.id }),
    });

  const supplier = await prisma.supplier.findUnique({ where: { waPhone } });
  if (supplier)
    return prisma.conversation.create({
      data: newConversationData(waPhone, { supplierId: supplier.id }),
    });

  const newCustomer = await prisma.customer.create({ data: { waPhone } });
  return prisma.conversation.create({
    data: newConversationData(waPhone, { customerId: newCustomer.id }),
  });
}

module.exports = { resolveConversation };
