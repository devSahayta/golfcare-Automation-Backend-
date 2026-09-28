// controllers/notificationController.js
//
// Module 8 — Recent Activity feed (Dashboard). Replaces a full Inbox UI —
// staff glance here to see what came in, then jump to Samvaadik's own
// dashboard to actually reply. Read-only, no read/unread tracking by
// design (kept simple per plan). Reads straight off the existing
// Message/Conversation tables — nothing new to write to.

const { prisma } = require("../lib/prisma");

const PREVIEW_MAX_CHARS = 140;

function truncate(text, max) {
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
}

function resolveContactName(conversation) {
  if (conversation.Customer) {
    const { firstName, lastName } = conversation.Customer;
    const full = [firstName, lastName].filter(Boolean).join(" ");
    return full || null;
  }
  if (conversation.Supplier) {
    return conversation.Supplier.name || null;
  }
  return null;
}

async function listNotifications(req, res) {
  const { limit, offset } = req.query;

  try {
    const take = Math.min(Number(limit) || 30, 100);
    const skip = Number(offset) || 0;

    const where = { direction: "INBOUND" };

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        take,
        skip,
        orderBy: { createdAt: "desc" },
        include: {
          Conversation: {
            select: {
              id: true,
              waPhone: true,
              customerId: true,
              supplierId: true,
              Customer: { select: { firstName: true, lastName: true } },
              Supplier: { select: { name: true } },
            },
          },
        },
      }),
      prisma.message.count({ where }),
    ]);

    const items = messages.map((message) => ({
      messageId: message.id,
      conversationId: message.conversationId,
      contactName: resolveContactName(message.Conversation),
      phone: message.Conversation.waPhone,
      contactType: message.Conversation.supplierId ? "SUPPLIER" : "CUSTOMER",
      preview: truncate(message.body, PREVIEW_MAX_CHARS),
      type: message.type,
      createdAt: message.createdAt,
    }));

    res.json({ items, total, limit: take, offset: skip });
  } catch (err) {
    console.error("listNotifications error:", err);
    res.status(500).json({ error: "Failed to fetch recent activity" });
  }
}

module.exports = { listNotifications };
