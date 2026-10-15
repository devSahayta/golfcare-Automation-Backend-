// scripts/testBroadcastCampaign.js
//
// End-to-end test for the broadcast campaign feature.
// Run with: node scripts/testBroadcastCampaign.js
//
// Tests (in order):
//   1. buildAudience — counts, consent filter, opt-out filter
//   2. draft_campaign tool — creates a DRAFT campaign + recipients
//   3. GET /api/campaigns/:id — verifies the row
//   4. POST /api/campaigns/:id/submit — creates the Samvaadik template
//   5. GET /api/campaigns/:id — Meta approval status poll
//   6. POST /api/campaigns/:id/send — schedules messages (to YOUR test phone only)
//
// Run steps 1–4 first. Steps 5–6 need Meta to actually approve,
// which can take minutes. Re-run with TEST_STEP=5 after approval.
//
// Set TEST_PHONE to your own WhatsApp number to receive the test message.

require("dotenv").config();
const { prisma } = require("../src/lib/prisma");
const { buildAudience } = require("../src/services/broadcastAudienceService");
const {
  getTemplateStatus,
  scheduleTemplateMessage,
} = require("../src/lib/samvaadik/adapter");

const TEST_PHONE = process.env.TEST_PHONE || ""; // e.g. "919876543210"
const TEST_STEP = Number(process.env.TEST_STEP || 0); // 0 = run all

async function step1_buildAudience() {
  console.log("\n── STEP 1: buildAudience ──");

  // Test 1a: empty rules — should return members ordered by LTV
  const a1 = await buildAudience({ isMember: true, limit: 5 });
  console.log(
    `All members (capped 5): ${a1.customers.length} eligible, ` +
      `${a1.excludedNoConsent} no-consent, ${a1.excludedOptedOut} opted-out`,
  );

  // Test 1b: product keywords
  const a2 = await buildAudience({
    productKeywords: ["ball", "golf ball"],
    orderWithinDays: 60,
  });
  console.log(
    `Ball buyers (60d): ${a2.customers.length} eligible, ` +
      `total matched: ${a2.totalMatched}`,
  );
  if (a2.customers.length > 0) {
    console.log(
      "  Sample:",
      a2.customers
        .slice(0, 3)
        .map((c) => `${c.firstName || "?"} ${c.lastName || ""} (${c.waPhone})`)
        .join(", "),
    );
  }

  // Test 1c: win-back
  const a3 = await buildAudience({ lastOrderMinDays: 90, isMember: true });
  console.log(`Win-back (90+ days no order): ${a3.customers.length} eligible`);

  console.log("✅ Step 1 done");
  return a2;
}

async function step2_draftCampaign(audienceResult) {
  console.log("\n── STEP 2: draft_campaign (direct service call) ──");

  if (audienceResult.customers.length === 0) {
    console.log(
      "⚠ No eligible customers for ball-buyer test — trying isMember instead",
    );
    audienceResult = await buildAudience({ isMember: true, limit: 3 });
  }

  if (audienceResult.customers.length === 0) {
    console.log("⚠ No eligible customers at all — skipping draft step");
    return null;
  }

  // Use the same logic the agent tool uses — create directly via Prisma
  const baseName = `test_pro_v1_${Date.now()}`;
  const templateName = `${baseName}`;

  const campaign = await prisma.$transaction(async (tx) => {
    const c = await tx.broadcastCampaign.create({
      data: {
        name: "TEST: Pro V1 arrival — ball buyers",
        templateName,
        bodyText:
          "Hi {{1}}, the new Titleist Pro V1 has just arrived at Golf Care. Reply to reserve a box.",
        audienceRules: { productKeywords: ["ball"], orderWithinDays: 60 },
        audienceSize: audienceResult.customers.length,
        agentPrompt: "test script",
        status: "DRAFT",
      },
    });

    await tx.broadcastRecipient.createMany({
      data: audienceResult.customers.map((cust) => ({
        campaignId: c.id,
        customerId: cust.id,
        phone: cust.waPhone,
        firstName: cust.firstName || null,
        status: "PENDING",
      })),
    });

    return c;
  });

  console.log(`✅ Campaign created: ${campaign.id}`);
  console.log(`   Name: ${campaign.name}`);
  console.log(`   Template: ${campaign.templateName}`);
  console.log(`   Recipients: ${audienceResult.customers.length}`);
  console.log(`   Status: ${campaign.status}`);
  return campaign;
}

async function step3_getCampaign(campaign) {
  console.log("\n── STEP 3: verify DB row ──");
  const c = await prisma.broadcastCampaign.findUnique({
    where: { id: campaign.id },
    include: { BroadcastRecipient: true },
  });
  console.log(`Campaign: ${c.id} status=${c.status}`);
  console.log(`Recipients in DB: ${c.BroadcastRecipient.length}`);
  console.log("✅ Step 3 done");
}

async function step4_submitToMeta(campaign) {
  console.log("\n── STEP 4: createTemplate on Samvaadik/Meta ──");
  const { createTemplate } = require("../src/lib/samvaadik/adapter");

  try {
    const result = await createTemplate(
      campaign.templateName,
      "MARKETING",
      campaign.bodyText,
      { language: "en_US", bodyExamples: ["Friend"] },
    );
    console.log(
      `✅ Template created on Samvaadik: wt_id=${result.wt_id} status=${result.status}`,
    );

    await prisma.broadcastCampaign.update({
      where: { id: campaign.id },
      data: {
        status: "SUBMITTED",
        samvaadikWtId: result.wt_id,
        metaStatus: "SUBMITTED",
        metaSubmittedAt: new Date(),
      },
    });
    console.log("   Campaign updated to SUBMITTED in DB");
    console.log(
      "\n⏰ Now wait for Meta to approve the template (minutes to hours).",
    );
    console.log(
      `   Re-run with: TEST_CAMPAIGN_ID=${campaign.id} TEST_STEP=5 node scripts/testBroadcastCampaign.js`,
    );
    return result;
  } catch (err) {
    console.error("❌ createTemplate failed:", err.message);
    throw err;
  }
}

async function step5_pollApproval(campaignId) {
  console.log("\n── STEP 5: poll Meta approval status ──");
  const c = await prisma.broadcastCampaign.findUnique({
    where: { id: campaignId },
  });
  if (!c) {
    console.error("Campaign not found");
    return;
  }
  if (!c.samvaadikWtId) {
    console.error("No samvaadikWtId — run step 4 first");
    return;
  }

  const status = await getTemplateStatus(c.samvaadikWtId);
  console.log(`Template status from Samvaadik: ${JSON.stringify(status)}`);

  if (status.status === "APPROVED") {
    await prisma.broadcastCampaign.update({
      where: { id: campaignId },
      data: {
        status: "READY",
        metaStatus: "META_APPROVED",
        metaApprovedAt: new Date(),
      },
    });
    console.log("✅ Meta APPROVED — campaign updated to READY");
    console.log(
      `   Re-run with: TEST_CAMPAIGN_ID=${campaignId} TEST_STEP=6 node scripts/testBroadcastCampaign.js`,
    );
  } else if (status.status === "REJECTED") {
    console.log("❌ Meta REJECTED the template");
  } else {
    console.log(
      `⏳ Status is still ${status.status} — wait longer and try again`,
    );
  }
}

async function step6_scheduleSend(campaignId) {
  console.log("\n── STEP 6: schedule sends ──");

  if (!TEST_PHONE) {
    console.log(
      "⚠ Set TEST_PHONE env var to your WhatsApp number to test actual sending",
    );
    console.log("  e.g. TEST_PHONE=919876543210 TEST_STEP=6 ...");
    return;
  }

  const c = await prisma.broadcastCampaign.findUnique({
    where: { id: campaignId },
    include: { BroadcastRecipient: { where: { phone: TEST_PHONE } } },
  });
  if (!c) {
    console.error("Campaign not found");
    return;
  }
  if (c.status !== "READY") {
    console.error(`Campaign is ${c.status}, must be READY`);
    return;
  }

  if (c.BroadcastRecipient.length === 0) {
    console.log(
      `⚠ TEST_PHONE ${TEST_PHONE} is not in this campaign's recipient list`,
    );
    console.log(
      "  Either add it manually or run a new draft with a rule that matches your test customer",
    );
    return;
  }

  const recipient = c.BroadcastRecipient[0];
  const scheduledAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();

  try {
    const result = await scheduleTemplateMessage({
      phone: recipient.phone,
      contactName: recipient.firstName || "Test",
      wtId: c.samvaadikWtId,
      templateVariables: { 1: recipient.firstName || "there" },
      scheduledAt,
      timezone: "Asia/Kolkata",
      batchId: campaignId,
    });

    await prisma.broadcastRecipient.update({
      where: { id: recipient.id },
      data: { status: "SCHEDULED", samvaadikSmId: result.sm_id },
    });

    console.log(`✅ Scheduled to ${TEST_PHONE}: sm_id=${result.sm_id}`);
    console.log(`   Will send at: ${scheduledAt}`);
    console.log(`   Check your WhatsApp in ~2 minutes!`);
  } catch (err) {
    console.error("❌ scheduleTemplateMessage failed:", err.message);
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const existingCampaignId = process.env.TEST_CAMPAIGN_ID;

  try {
    if (TEST_STEP === 5) {
      if (!existingCampaignId) throw new Error("Set TEST_CAMPAIGN_ID env var");
      await step5_pollApproval(existingCampaignId);
    } else if (TEST_STEP === 6) {
      if (!existingCampaignId) throw new Error("Set TEST_CAMPAIGN_ID env var");
      await step6_scheduleSend(existingCampaignId);
    } else {
      // Steps 1–4: full draft + submit
      const audienceResult = await step1_buildAudience();
      const campaign = await step2_draftCampaign(audienceResult);
      if (!campaign) {
        console.log("Stopping — no eligible customers");
        return;
      }
      await step3_getCampaign(campaign);
      await step4_submitToMeta(campaign);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("Test script failed:", err);
  process.exit(1);
});
