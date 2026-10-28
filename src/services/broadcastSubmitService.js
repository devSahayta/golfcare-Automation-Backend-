// src/services/broadcastSubmitService.js
//
// Extracted from broadcastCampaignController.js's submitCampaign handler so
// the exact same "push this DRAFT's template to Meta via Samvaadik" logic
// can be called from two places: the staff-facing POST /:id/submit route,
// and the Insights agent's schedule_campaign_broadcast tool (see
// insightsAgentTools.js) — which now submits on the staff member's verbal
// behalf when they give a schedule time. Previously only the HTTP route
// existed; this file has no req/res, just the DB + Samvaadik work, so
// either caller can use it and get identical behavior (no drift).
//
// Throws on failure — callers decide how to surface that (HTTP 500 vs a
// tool-result error the agent reads back to the staff member).

const { prisma } = require("../lib/prisma");
const {
  createTemplate,
  uploadMediaFromUrl,
} = require("../lib/samvaadik/adapter");
const { generateAIComposedCampaignImage } = require("./imageGenerationService");

class SubmitError extends Error {
  constructor(message, { status = 500, hint } = {}) {
    super(message);
    this.status = status;
    this.hint = hint;
  }
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

// staffId is the logged-in staff user when called from the HTTP route, or
// null when the Insights agent is submitting on the staff member's behalf
// (writeAudit already treats a null staffId as actorType "AGENT" — same
// distinction the rest of this codebase uses for agent-initiated writes).
async function submitBroadcastCampaignToMeta(
  campaignId,
  { staffId = null } = {},
) {
  const campaign = await prisma.broadcastCampaign.findUnique({
    where: { id: campaignId },
  });
  if (!campaign) throw new SubmitError("Campaign not found", { status: 404 });
  if (campaign.status !== "DRAFT") {
    throw new SubmitError(
      `Cannot submit — campaign is already ${campaign.status}`,
      {
        status: 409,
      },
    );
  }

  const templateOptions = {
    language: "en_US",
    bodyExamples: ["Friend"],
  };

  if (campaign.footerText) templateOptions.footerText = campaign.footerText;
  if (campaign.buttons && campaign.buttons.length > 0)
    templateOptions.buttons = campaign.buttons;

  if (campaign.headerType === "TEXT" && campaign.headerText) {
    templateOptions.headerFormat = "TEXT";
    templateOptions.headerText = campaign.headerText;
  } else if (campaign.headerType === "IMAGE") {
    console.log(
      `[broadcastSubmitService] IMAGE header requested for campaign "${campaign.name}"`,
    );

    // Use the image already generated/previewed in the Insights widget
    // (headerImageUrl stored at draft time) whenever possible — this is
    // the common path for both the dashboard button AND the agent, and
    // keeps this call fast (no new AI generation call) in both cases.
    let generatedImageUrl = campaign.headerImageUrl || null;

    if (!generatedImageUrl) {
      console.log(
        "[broadcastSubmitService] No preview image found — generating now via FLUX.2 Pro",
      );
      const backdropHint =
        campaign.agentPrompt || campaign.category || "golf campaign";
      try {
        const { imageUrl } = await generateAIComposedCampaignImage({
          campaignName: campaign.name,
          backdropHint,
        });
        generatedImageUrl = imageUrl;
      } catch (genErr) {
        console.error(
          "[broadcastSubmitService] Image generation failed:",
          genErr.message,
        );
        throw new SubmitError("Failed to generate header image", {
          hint: "Check REPLICATE_API_TOKEN in .env. The campaign is still a DRAFT — fix the issue and retry.",
        });
      }
    }

    let uploadResult;
    try {
      const fileName = `${campaign.templateName}_header.jpg`;
      uploadResult = await uploadMediaFromUrl({
        url: generatedImageUrl,
        fileName,
        fileType: "image/jpeg",
      });
      console.log(
        `[broadcastSubmitService] Image uploaded to Meta — headerHandle: ${uploadResult.headerHandle}`,
      );
    } catch (uploadErr) {
      console.error(
        "[broadcastSubmitService] Media upload failed:",
        uploadErr.message,
      );
      throw new SubmitError("Failed to upload header image to Meta", {
        hint: "Image was generated successfully but the Meta upload failed. Retry submission.",
      });
    }

    if (!campaign.headerImageUrl) {
      await prisma.broadcastCampaign.update({
        where: { id: campaignId },
        data: { headerImageUrl: generatedImageUrl },
      });
    }

    templateOptions.headerFormat = "IMAGE";
    templateOptions.headerHandle = uploadResult.headerHandle;
    if (uploadResult.mediaId) templateOptions.mediaId = uploadResult.mediaId;
  }

  const result = await createTemplate(
    campaign.templateName,
    campaign.category,
    campaign.bodyText,
    templateOptions,
  );

  await prisma.broadcastCampaign.update({
    where: { id: campaignId },
    data: {
      status: "SUBMITTED",
      samvaadikWtId: result.wt_id,
      metaStatus: "SUBMITTED",
      metaSubmittedAt: new Date(),
      confirmedAt: new Date(),
    },
  });

  await writeAudit(
    "TEMPLATE_SUBMITTED",
    campaignId,
    staffId,
    { status: "DRAFT" },
    {
      status: "SUBMITTED",
      wt_id: result.wt_id,
      headerType: campaign.headerType,
    },
  );

  return { samvaadikWtId: result.wt_id, metaStatus: result.status };
}

module.exports = { submitBroadcastCampaignToMeta, SubmitError };
