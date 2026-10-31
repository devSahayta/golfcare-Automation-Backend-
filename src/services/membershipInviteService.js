// src/services/membershipInviteService.js
//
// Real-time counterpart to golfcare-scheduler's static-lane campaigns
// (campaignTriggerEval.js's evaluateBirthdays/evaluateReplenishment) —
// same shape (CampaignTrigger + pre-approved template name + Message/
// Conversation logging via the campaign_reply:SCENARIO intent tag), but
// fired synchronously from THIS request (the Shopify orders/create
// webhook) rather than on a scheduler cron tick. Deliberately real-time:
// a customer who just bought something is told about free membership
// while the moment is fresh, not up to 30 minutes later on the next tick.
//
// Called from shopifyWebhookController.js's handleOrderUpsert, only for a
// genuinely NEW order (never on a redelivery/update — see that file's own
// !existing gate) that resolved to a real Customer.
//
// Always uses sendTemplate, never sendText-with-session-check (unlike the
// scheduler's sendStaticMessage helper) — many of these customers are
// brand-new, created moments ago straight from Shopify order data (see
// shopifyWebhookController.js's resolveOrCreateCustomerFromShopify), with
// no WhatsApp conversation history at all, so there is no open session
// window to even check.
//
// "Once ever" per customer: before sending, checks whether a
// MEMBERSHIP_INVITE CampaignTrigger already exists for this customer, in
// ANY status (PENDING/SENT/SUPPRESSED) — a prior attempt, successful or
// not, counts as "already tried" and this never retries on a later order.

const { prisma } = require("../lib/prisma");
const { env } = require("../config/env");
const { sendTemplate } = require("../lib/samvaadik/adapter");
const {
  resolveCustomerConversationForSend,
} = require("../lib/resolveCustomerConversationForSend");

// Best-effort, deliberately non-throwing: this runs inside
// handleOrderUpsert, after the order itself already saved successfully.
// A failure here (template send error, Samvaadik outage, etc.) must never
// turn a successful order sync into a 500 — it's logged and the
// CampaignTrigger is marked SUPPRESSED with the reason, same recovery
// shape as the scheduler's own send-failure handling.
//
// The "once ever" guarantee is now enforced at the DB level: a partial
// unique index on CampaignTrigger("customerId") WHERE scenario =
// 'MEMBERSHIP_INVITE' (run manually in Supabase — see
// scripts/addMembershipTriggerUniqueIndex.sql) means the create() below
// either wins outright or fails with P2002 if another concurrent call (or
// a later redelivered webhook) already claimed this customer. This
// replaces a separate findFirst-then-create pre-check, which was its own
// check-then-act race — confirmed live on 2026-10-31 (two invite sends for
// one order, traced to shopifyWebhookController.js's own race, now fixed
// there too with an advisory lock — this is defense in depth for any other
// path that can call this function more than once for the same customer).
async function maybeSendMembershipInvite(customer) {
  try {
    if (!customer || customer.isMember)
      return { sent: false, reason: "already_member" };
    if (!customer.waPhone) return { sent: false, reason: "no_phone" };

    const templateName = env.campaignTemplates.MEMBERSHIP_INVITE;
    if (!templateName) {
      console.warn(
        "[membershipInviteService] MEMBERSHIP_INVITE_TEMPLATE_NAME not configured — skipping invite.",
      );
      return { sent: false, reason: "template_not_configured" };
    }

    let trigger;
    try {
      trigger = await prisma.campaignTrigger.create({
        data: {
          customerId: customer.id,
          scenario: "MEMBERSHIP_INVITE",
          status: "PENDING",
        },
      });
    } catch (err) {
      if (err.code === "P2002") {
        // Someone else (a concurrent call, or a prior attempt) already
        // claimed this customer — exactly the "once ever" guarantee
        // working as intended, not a real error.
        return { sent: false, reason: "already_invited_once" };
      }
      throw err;
    }

    const firstName = customer.firstName || "there";
    // Our own locally-composed record of what the customer saw — same
    // convention as campaignTriggerEval.js's logSendAndCloseTrigger
    // (Meta's exact approved copy isn't fetched back, this is an
    // accurate-enough stand-in so Sales Agent has real text in history).
    // Must stay byte-identical to scripts/createMembershipTemplateV2.js's
    // BODY_TEXT (minus the {{1}} placeholder) so this record matches what
    // Meta actually delivered. The "member pricing"/🏷️ wording here is
    // fine even though that phrase is also the hasPitchedMembership/
    // enroll_membership pitchSent marker (see salesAgentConfig.js) —
    // that guard only scans messages with sender AI_AGENT, and this one is
    // logged with sender SYSTEM, so it can never satisfy the guard on its
    // own. The real STEP 2 benefits pitch still has to happen live in chat
    // before enroll_membership will allow enrollment.
    //
    // V2: this invite now also offers two tappable QUICK_REPLY buttons
    // ("Tell me more" / "Not right now") on the actual WhatsApp message —
    // a button tap arrives as a normal inbound message with the button's
    // label as its text (handled by the existing webhook, no code changes
    // needed), so it flows into the sales agent exactly like a typed reply.
    const messageBody = `Hi ${firstName}, thanks for your order with Golf Care! 🏌️ Quick one — we've got a free membership program with special pricing, early access to new stock, and a golf expert on WhatsApp whenever you need one. Want to hear more?`;

    let sendResult;
    try {
      sendResult = await sendTemplate(customer.waPhone, templateName, [
        firstName,
      ]);
    } catch (err) {
      console.error(
        `[membershipInviteService] send failed for customer ${customer.id}:`,
        err.message,
      );
      await prisma.campaignTrigger.update({
        where: { id: trigger.id },
        data: {
          status: "SUPPRESSED",
          suppressedReason: `send_failed: ${err.message}`.slice(0, 250),
        },
      });
      return { sent: false, reason: "send_failed" };
    }

    const conversation = await resolveCustomerConversationForSend(customer);
    await prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: "OUTBOUND",
        sender: "SYSTEM",
        type: "template",
        templateName,
        body: messageBody,
        waMessageId: sendResult?.waMessageId || null,
        createdAt: new Date(),
      },
    });
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(),
        intent: "campaign_reply:MEMBERSHIP_INVITE",
      },
    });
    await prisma.campaignTrigger.update({
      where: { id: trigger.id },
      data: { status: "SENT" },
    });
    await prisma.auditLog.create({
      data: {
        actorType: "AGENT",
        action: "campaign_message_sent",
        entityType: "CampaignTrigger",
        entityId: trigger.id,
        afterState: {
          scenario: "MEMBERSHIP_INVITE",
          customerId: customer.id,
          templateName,
        },
        source: "membership_invite_service",
      },
    });

    return { sent: true };
  } catch (err) {
    // Outermost safety net — e.g. the CampaignTrigger.create call itself
    // failing. Never let this escape into handleOrderUpsert's caller.
    console.error(
      `[membershipInviteService] unexpected error for customer ${customer?.id}:`,
      err.message,
    );
    return { sent: false, reason: "unexpected_error" };
  }
}

module.exports = { maybeSendMembershipInvite };
