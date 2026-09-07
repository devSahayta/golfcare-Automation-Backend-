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
const { ENROLMENT_QUESTIONS } = require("../salesAgent/enrolmentQuestions");

const ENROLMENT_FIELD_KEYS = ENROLMENT_QUESTIONS.map((q) => q.fieldKey);

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
  let pendingCheck = null; // populated below only if participant is a supplier
  let enrolmentPending = false;
  let enrolmentMissingFields = [];

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

    // Deterministic check — but must only fire once the REAL benefits
    // pitch (with bullets) has been sent, not just a bare "have you
    // thought about joining?" invite. The old /membership/i regex matched
    // even the bare invite, which meant a customer ignoring or not
    // addressing that first mention (e.g. replying about something else
    // entirely) permanently locked the model out of ever bringing it up
    // again for the rest of the conversation — the invite went
    // unanswered, membership was never actually explained, and the
    // model was told "already pitched, don't re-ask." This marker
    // matches the same bullet-benefits text used in the enroll_membership
    // tool guard, so both stay in sync.
    hasPitchedMembership = recentMessages.some(
      (m) => m.sender === "AI_AGENT" && /member pricing|🏷️/.test(m.body || ""),
    );

    // Part A enrolment gate — separate from Part C progressive profiling
    // above. IN_PROGRESS means they've said yes to joining but haven't
    // finished the fixed 7-question sequence yet.
    enrolmentPending = conversation.Customer?.onboardingState === "IN_PROGRESS";
    if (enrolmentPending) {
      const enrolmentAnswered = await prisma.onboardingResponse.findMany({
        where: {
          customerId: conversation.customerId,
          fieldKey: { in: ENROLMENT_FIELD_KEYS },
        },
        select: { fieldKey: true },
      });
      const enrolmentAnsweredSet = new Set(
        enrolmentAnswered.map((a) => a.fieldKey),
      );
      enrolmentMissingFields = ENROLMENT_QUESTIONS.filter(
        (q) => !enrolmentAnsweredSet.has(q.fieldKey),
      );
    }
  }

  if (participantType === "SUPPLIER" && conversation.supplierId) {
    pendingCheck = await prisma.supplierCheck.findFirst({
      where: { supplierId: conversation.supplierId, status: "SENT" },
      orderBy: { sentAt: "desc" },
    });
  }

  return {
    conversation,
    participantType,
    customer: conversation.Customer || null,
    golferProfile: conversation.Customer?.GolferProfile || null,
    supplier: conversation.Supplier || null,
    unansweredQuestions,
    hasPitchedMembership,
    pendingCheck,
    enrolmentPending,
    enrolmentMissingFields,
    recentMessages,
    priorSummary: conversation.summary || null,
  };
}

module.exports = { assembleContext };
