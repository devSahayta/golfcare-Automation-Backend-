// src/services/broadcastFanOutService.js
//
// Extracted from broadcastCampaignController.js's sendCampaign and
// scheduleCampaign handlers — both did the exact same thing (re-check
// consent, skip anyone who opted out since the draft was built, then fan
// out one Samvaadik scheduleTemplateMessage call per recipient in small
// batches) with only the target send time differing. Kept as one place so
// the two don't drift, and so it can be awaited inside @vercel/functions'
// waitUntil() instead of the bare setImmediate() the original two
// handlers used.
//
// Why that matters on Vercel: setImmediate() queues a callback for the
// *next* tick of this same invocation — it does NOT keep the serverless
// function instance alive. Once res.json()/res.send() has gone out,
// Vercel is free to freeze or tear down the instance at any point after
// that, including before the setImmediate callback ever runs. For a
// handful of recipients this often appeared to work anyway (the freeze
// didn't land in time to matter), but it's not guaranteed, and a bigger
// campaign (max 200 recipients, batched 10 at a time with a 300ms gap —
// nearly 6s of real wall-clock fan-out work) raises the odds of the
// instance disappearing mid-loop and silently leaving recipients stuck
// PENDING. @vercel/functions' waitUntil() is Vercel's documented fix for
// exactly this: it keeps the invocation alive until the passed promise
// settles, without holding up the HTTP response. This is the same pattern
// already used (and explained at length) in src/webhooks/samvaadik.js —
// see that file's comments for the fuller story of how this bit the team
// once already on the inbound-message path.

const { prisma } = require("../lib/prisma");
const { scheduleTemplateMessage } = require("../lib/samvaadik/adapter");

const BATCH_SIZE = 10;
const SEND_DELAY_MS = 300;

// Manual retry (staff clicks "Retry failed messages" on the dashboard) is
// capped so a genuinely bad number can't be retried forever — past this,
// prepareRetry skips the recipient and reports it as "at retry cap" instead
// of silently retrying indefinitely.
const MAX_RETRY_ATTEMPTS = 3;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function writeAudit(action, campaignId, staffId, before, after) {
  return prisma.auditLog.create({
    data: {
      actorType: staffId ? "STAFF" : "AGENT",
      actorId: staffId || null,
      action,
      entityType: "BroadcastCampaign",
      entityId: campaignId,
      beforeState: before || null,
      afterState: after || null,
      source: "broadcast_campaign_controller",
    },
  });
}

// Re-checks consent for every PENDING recipient, skips anyone who's opted
// out or lost consent since the draft/preview was built, marks the
// campaign SCHEDULED with the given sendAt, and returns the still-eligible
// recipients plus a skipped count. Does NOT do the actual fan-out — that's
// step 2 below — so callers can respond to the HTTP request (or let the
// caller's own caller proceed) immediately after this resolves.
async function prepareFanOut({
  campaignId,
  sendAt,
  timezone,
  auditAction,
  staffId,
}) {
  const campaign = await prisma.broadcastCampaign.findUnique({
    where: { id: campaignId },
    include: {
      BroadcastRecipient: {
        where: { status: "PENDING" },
        select: { id: true, phone: true, firstName: true, customerId: true },
      },
    },
  });

  if (!campaign) return { ok: false, error: "Campaign not found", status: 404 };
  if (!campaign.samvaadikWtId) {
    return {
      ok: false,
      error: "No Samvaadik template ID — submit to Meta first.",
      status: 409,
    };
  }

  const customerIds = campaign.BroadcastRecipient.map((r) => r.customerId);
  const freshCustomers = await prisma.customer.findMany({
    where: { id: { in: customerIds } },
    select: { id: true, consentMarketing: true, optedOutAt: true },
  });
  const consentMap = new Map(freshCustomers.map((c) => [c.id, c]));

  const eligible = [];
  const skipped = [];
  for (const r of campaign.BroadcastRecipient) {
    const c = consentMap.get(r.customerId);
    if (!c) skipped.push({ id: r.id, reason: "customer_not_found" });
    else if (c.optedOutAt) skipped.push({ id: r.id, reason: "opted_out" });
    else if (!c.consentMarketing)
      skipped.push({ id: r.id, reason: "no_consent" });
    else eligible.push(r);
  }

  if (skipped.length > 0) {
    await prisma.$transaction(
      skipped.map((s) =>
        prisma.broadcastRecipient.update({
          where: { id: s.id },
          data: { status: "SKIPPED", skipReason: s.reason },
        }),
      ),
    );
  }

  if (eligible.length === 0) {
    await prisma.broadcastCampaign.update({
      where: { id: campaignId },
      data: { status: "CANCELLED", skippedCount: skipped.length },
    });
    return {
      ok: false,
      error:
        "No eligible recipients remain — all were skipped due to consent/opt-out changes.",
      status: 409,
      skipped: skipped.length,
    };
  }

  await prisma.broadcastCampaign.update({
    where: { id: campaignId },
    data: {
      status: "SCHEDULED",
      scheduledFor: sendAt,
      skippedCount: skipped.length,
    },
  });

  await writeAudit(
    auditAction,
    campaignId,
    staffId,
    { status: campaign.status },
    {
      status: "SCHEDULED",
      recipients: eligible.length,
      skipped: skipped.length,
    },
  );

  return {
    ok: true,
    campaignId,
    samvaadikWtId: campaign.samvaadikWtId,
    eligible,
    skipped: skipped.length,
    sendAt,
    timezone,
  };
}

// The actual fan-out loop — call via waitUntil(fanOutBroadcastCampaign(...))
// after responding to the HTTP request (or directly, awaited, from a
// non-HTTP caller like a scheduler cron tick, which has no response to
// hold up and no freeze risk in the first place).
async function fanOutBroadcastCampaign({
  campaignId,
  samvaadikWtId,
  eligible,
  sendAt,
  timezone,
}) {
  let scheduledOk = 0;
  let scheduledFail = 0;

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (r) => {
        try {
          const result = await scheduleTemplateMessage({
            phone: r.phone,
            contactName: r.firstName || undefined,
            wtId: samvaadikWtId,
            templateVariables: { 1: r.firstName || "there" },
            scheduledAt: sendAt.toISOString(),
            timezone,
            batchId: campaignId,
          });
          await prisma.broadcastRecipient.update({
            where: { id: r.id },
            data: { status: "SCHEDULED", samvaadikSmId: result.sm_id },
          });
          scheduledOk++;
        } catch (err) {
          console.error(
            `[broadcastFanOutService] schedule failed for recipient ${r.id}:`,
            err.message,
          );
          await prisma.broadcastRecipient.update({
            where: { id: r.id },
            data: {
              status: "FAILED",
              errorMessage: err.message?.slice(0, 500),
            },
          });
          scheduledFail++;
        }
      }),
    );

    if (i + BATCH_SIZE < eligible.length) await sleep(SEND_DELAY_MS);
  }

  if (scheduledOk === 0 && scheduledFail > 0) {
    await prisma.broadcastCampaign.update({
      where: { id: campaignId },
      data: { status: "FAILED", failedCount: scheduledFail },
    });
  } else {
    await prisma.broadcastCampaign.update({
      where: { id: campaignId },
      data: { failedCount: scheduledFail },
    });
  }

  console.log(
    `[broadcastFanOutService] campaign ${campaignId} fan-out done — ok:${scheduledOk} fail:${scheduledFail} sendAt:${sendAt.toISOString()}`,
  );
  return { scheduledOk, scheduledFail };
}

// Re-checks consent for every FAILED recipient (same reasoning as
// prepareFanOut — time has passed since the original attempt, and a
// customer may have opted out since), skips anyone who's already hit
// MAX_RETRY_ATTEMPTS, moves the campaign back to SCHEDULED (so the existing
// send-status polling in getCampaign and the scheduler's
// pollBroadcastSendStatus picks these up again exactly like a fresh send),
// and returns the still-eligible recipients. Does NOT do the actual retry
// send — that's retryFailedRecipients below.
async function prepareRetry({ campaignId, staffId }) {
  const campaign = await prisma.broadcastCampaign.findUnique({
    where: { id: campaignId },
    include: {
      BroadcastRecipient: {
        where: { status: "FAILED" },
        select: {
          id: true,
          phone: true,
          firstName: true,
          customerId: true,
          retryCount: true,
        },
      },
    },
  });

  if (!campaign) return { ok: false, error: "Campaign not found", status: 404 };
  if (!campaign.samvaadikWtId) {
    return {
      ok: false,
      error:
        "No Samvaadik template ID on this campaign — nothing to retry against.",
      status: 409,
    };
  }
  if (campaign.BroadcastRecipient.length === 0) {
    return { ok: false, error: "No failed recipients to retry.", status: 409 };
  }

  const atCap = campaign.BroadcastRecipient.filter(
    (r) => r.retryCount >= MAX_RETRY_ATTEMPTS,
  );
  const underCap = campaign.BroadcastRecipient.filter(
    (r) => r.retryCount < MAX_RETRY_ATTEMPTS,
  );

  if (underCap.length === 0) {
    return {
      ok: false,
      error: `All ${atCap.length} failed recipient(s) have already hit the ${MAX_RETRY_ATTEMPTS}-retry limit.`,
      status: 409,
    };
  }

  const customerIds = underCap.map((r) => r.customerId);
  const freshCustomers = await prisma.customer.findMany({
    where: { id: { in: customerIds } },
    select: { id: true, consentMarketing: true, optedOutAt: true },
  });
  const consentMap = new Map(freshCustomers.map((c) => [c.id, c]));

  const eligible = [];
  const skipped = [];
  for (const r of underCap) {
    const c = consentMap.get(r.customerId);
    if (!c) skipped.push({ id: r.id, reason: "customer_not_found" });
    else if (c.optedOutAt) skipped.push({ id: r.id, reason: "opted_out" });
    else if (!c.consentMarketing)
      skipped.push({ id: r.id, reason: "no_consent" });
    else eligible.push(r);
  }

  if (skipped.length > 0) {
    await prisma.$transaction(
      skipped.map((s) =>
        prisma.broadcastRecipient.update({
          where: { id: s.id },
          data: { status: "SKIPPED", skipReason: s.reason },
        }),
      ),
    );
  }

  if (eligible.length === 0) {
    return {
      ok: false,
      error:
        "No eligible recipients remain to retry — all were skipped due to consent/opt-out changes, or already hit the retry limit.",
      status: 409,
      skipped: skipped.length,
    };
  }

  // Back to SCHEDULED so the existing send-status polling (getCampaign's
  // live refresh, and the scheduler's pollBroadcastSendStatus) resumes
  // watching this campaign for delivery outcomes, same as a fresh send.
  await prisma.broadcastCampaign.update({
    where: { id: campaignId },
    data: { status: "SCHEDULED", completedAt: null },
  });

  await writeAudit(
    "RETRY_INITIATED",
    campaignId,
    staffId,
    {
      status: campaign.status,
      failedCount: campaign.BroadcastRecipient.length,
    },
    {
      status: "SCHEDULED",
      retrying: eligible.length,
      skipped: skipped.length,
      atRetryCap: atCap.length,
    },
  );

  return {
    ok: true,
    campaignId,
    samvaadikWtId: campaign.samvaadikWtId,
    eligible,
    skipped: skipped.length,
    atRetryCap: atCap.length,
  };
}

// The actual retry fan-out — call via waitUntil(retryFailedRecipients(...))
// after responding to the HTTP request, same reasoning as
// fanOutBroadcastCampaign above.
async function retryFailedRecipients({
  campaignId,
  samvaadikWtId,
  eligible,
  sendAt,
  timezone,
}) {
  let retriedOk = 0;
  let retriedFail = 0;

  for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
    const batch = eligible.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async (r) => {
        try {
          const result = await scheduleTemplateMessage({
            phone: r.phone,
            contactName: r.firstName || undefined,
            wtId: samvaadikWtId,
            templateVariables: { 1: r.firstName || "there" },
            scheduledAt: sendAt.toISOString(),
            timezone,
            batchId: campaignId,
          });
          await prisma.broadcastRecipient.update({
            where: { id: r.id },
            data: {
              status: "SCHEDULED",
              samvaadikSmId: result.sm_id,
              errorMessage: null,
              retryCount: r.retryCount + 1,
            },
          });
          retriedOk++;
        } catch (err) {
          console.error(
            `[broadcastFanOutService] retry failed for recipient ${r.id}:`,
            err.message,
          );
          await prisma.broadcastRecipient.update({
            where: { id: r.id },
            data: {
              status: "FAILED",
              errorMessage: err.message?.slice(0, 500),
              retryCount: r.retryCount + 1,
            },
          });
          retriedFail++;
        }
      }),
    );

    if (i + BATCH_SIZE < eligible.length) await sleep(SEND_DELAY_MS);
  }

  // Recompute from the DB rather than incrementing — some recipients may
  // already be SENT from the original attempt, so a naive increment would
  // double-count against the original fan-out's tally.
  const [sentCount, failedCount] = await Promise.all([
    prisma.broadcastRecipient.count({ where: { campaignId, status: "SENT" } }),
    prisma.broadcastRecipient.count({
      where: { campaignId, status: "FAILED" },
    }),
  ]);
  await prisma.broadcastCampaign.update({
    where: { id: campaignId },
    data: { sentCount, failedCount },
  });

  console.log(
    `[broadcastFanOutService] campaign ${campaignId} retry done — ok:${retriedOk} fail:${retriedFail}`,
  );
  return { retriedOk, retriedFail };
}

module.exports = {
  prepareFanOut,
  fanOutBroadcastCampaign,
  prepareRetry,
  retryFailedRecipients,
};
