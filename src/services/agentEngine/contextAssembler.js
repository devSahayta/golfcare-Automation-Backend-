// src/services/agentEngine/contextAssembler.js
//
// Generic over participant type — resolves whatever's on the Conversation
// (Customer or Supplier), pulls recent history, and (for customers) which
// OnboardingQuestions are still unanswered. Sales+Membership uses the
// Customer/GolferProfile/unansweredQuestions fields; a future Supplier
// Agent would read Supplier/SupplierProduct off the same conversation
// instead — this function doesn't need to change for that, callers just
// read different fields off the returned context.

const { prisma } = require("../../lib/prisma");
const { env } = require("../../config/env");

async function assembleContext({ conversationId }) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      Customer: { include: { GolferProfile: true } },
      Supplier: true,
    },
  });
  if (!conversation)
    throw new Error(`Conversation ${conversationId} not found`);

  const participantType = conversation.customerId
    ? "CUSTOMER"
    : conversation.supplierId
      ? "SUPPLIER"
      : "UNKNOWN";

  const recentMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: env.agentHistoryMessageLimit,
  });
  recentMessages.reverse(); // chronological order for the model

  const answeredKeys = new Set(); // populated below only if participant is a customer
  let unansweredQuestions = [];
  let hasPitchedMembership = false;

  if (participantType === "CUSTOMER" && conversation.customerId) {
    const [allQuestions, answered] = await Promise.all([
      prisma.onboardingQuestion.findMany({
        where: { isActive: true },
        orderBy: { order: "asc" },
      }),
      prisma.onboardingResponse.findMany({
        where: { customerId: conversation.customerId },
        select: { fieldKey: true },
      }),
    ]);
    answered.forEach((a) => answeredKeys.add(a.fieldKey));
    unansweredQuestions = allQuestions.filter(
      (q) => !answeredKeys.has(q.fieldKey),
    );

    // Deterministic check, not left to the model to notice on its own —
    // it already re-pitched once in testing despite the prior pitch
    // being right there in history.
    hasPitchedMembership = recentMessages.some(
      (m) => m.sender === "AI_AGENT" && /membership/i.test(m.body || ""),
    );
  }

  return {
    conversation,
    participantType,
    customer: conversation.Customer || null,
    golferProfile: conversation.Customer?.GolferProfile || null,
    supplier: conversation.Supplier || null,
    unansweredQuestions,
    hasPitchedMembership,
    recentMessages,
    priorSummary: conversation.summary || null,
  };
}

module.exports = { assembleContext };
