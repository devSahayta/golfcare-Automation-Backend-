// src/controllers/broadcastCampaignController.js
//
// REST endpoints for the broadcast campaign card in the Insights widget.
// The agent ONLY creates DRAFT rows. Every state transition after that
// (submit → Meta, send, cancel) is a button click from a logged-in staff
// member through these endpoints — never the LLM.
//
// Flow:
//   DRAFT ──(POST /submit)──► SUBMITTED ──(Meta approves)──► READY
//   READY ──(POST /send)────► SCHEDULED ──(Samvaadik delivers)──► COMPLETED
//   Any non-COMPLETED ──(POST /cancel)──► CANCELLED
//
// Status is polled by the frontend card via GET /:id — it reads
// Samvaadik's batch status fresh every time so the card stays live
// without a background job.

const { prisma } = require("../lib/prisma");
const {
  createTemplate,
  getTemplateStatus,
  scheduleTemplateMessage,
  listScheduledMessages,
  uploadMediaFromUrl,
} = require("../lib/samvaadik/adapter");
const {
  generateRawProductCampaignImage,
  generateAIComposedCampaignImage,
} = require("../services/imageGenerationService");
const {
  matchProductImage,
  getProductPhotosByTitles,
} = require("../services/productImageMatchService");
const { logUsage } = require("../services/agentEngine/logger");

const BATCH_SIZE = 10; // schedule this many recipients per loop iteration
const SEND_DELAY_MS = 300; // ms between batches — stay well under Samvaadik rate limits
const TIMEZONE = process.env.SCHEDULER_TIMEZONE || "Asia/Kolkata";
const QUIET_HOURS_START = Number(process.env.CAMPAIGN_QUIET_HOURS_START ?? 21);
const QUIET_HOURS_END = Number(process.env.CAMPAIGN_QUIET_HOURS_END ?? 8);

// ── helpers ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getLocalHour(timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  const raw = parts.find((p) => p.type === "hour").value;
  return raw === "24" ? 0 : Number(raw);
}

// Honour quiet hours — same logic as scheduler's templateStatusPoll.js.
// Sends during quiet hours are pushed to the next QUIET_HOURS_END.
function computeSendTime() {
  const hour = getLocalHour(TIMEZONE);
  const inQuiet = hour >= QUIET_HOURS_START || hour < QUIET_HOURS_END;
  if (!inQuiet) return new Date(Date.now() + 2 * 60 * 1000); // 2 min from now

  const target = new Date();
  target.setMinutes(0, 0, 0);
  if (hour >= QUIET_HOURS_START) target.setDate(target.getDate() + 1);
  target.setHours(QUIET_HOURS_END, 0, 0, 0);
  return target;
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

// ── GET /api/broadcast-campaigns — list ─────────────────────────────────────────────

async function listCampaigns(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const skip = (page - 1) * limit;
    const { status } = req.query;

    const where = status ? { status } : {};
    const [total, campaigns] = await Promise.all([
      prisma.broadcastCampaign.count({ where }),
      prisma.broadcastCampaign.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          status: true,
          audienceSize: true,
          sentCount: true,
          failedCount: true,
          skippedCount: true,
          templateName: true,
          bodyText: true,
          metaStatus: true,
          metaRejectionReason: true,
          createdAt: true,
          confirmedAt: true,
          scheduledFor: true,
          completedAt: true,
          createdByStaffId: true,
        },
      }),
    ]);

    return res.json({
      data: campaigns,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("listCampaigns error:", err);
    return res.status(500).json({ error: "Failed to fetch campaigns" });
  }
}

// ── GET /api/broadcast-campaigns/:id — status (used by card polling) ───────────────

async function getCampaign(req, res) {
  try {
    const campaign = await prisma.broadcastCampaign.findUnique({
      where: { id: req.params.id },
      include: {
        BroadcastRecipient: {
          select: {
            id: true,
            firstName: true,
            phone: true,
            status: true,
            samvaadikSmId: true, // ← FIX: was missing, caused recipient status to never update
            skipReason: true,
            errorMessage: true,
            sentAt: true,
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    // ── Live Meta approval check while SUBMITTED ──────────────────────
    if (campaign.status === "SUBMITTED" && campaign.samvaadikWtId) {
      try {
        const tplStatus = await getTemplateStatus(campaign.samvaadikWtId);
        if (
          tplStatus.status === "APPROVED" &&
          campaign.metaStatus !== "META_APPROVED"
        ) {
          await prisma.broadcastCampaign.update({
            where: { id: campaign.id },
            data: {
              status: "READY",
              metaStatus: "META_APPROVED",
              metaApprovedAt: new Date(),
            },
          });
          campaign.status = "READY";
          campaign.metaStatus = "META_APPROVED";
          await writeAudit(
            "META_APPROVED",
            campaign.id,
            null,
            { status: "SUBMITTED" },
            { status: "READY" },
          );
        } else if (
          tplStatus.status === "REJECTED" &&
          campaign.metaStatus !== "META_REJECTED"
        ) {
          await prisma.broadcastCampaign.update({
            where: { id: campaign.id },
            data: {
              status: "REJECTED",
              metaStatus: "META_REJECTED",
              metaRejectionReason: "Rejected by Meta",
            },
          });
          campaign.status = "REJECTED";
          await writeAudit(
            "META_REJECTED",
            campaign.id,
            null,
            { status: "SUBMITTED" },
            { status: "REJECTED" },
          );
        }
      } catch (pollErr) {
        // Non-fatal — just return current DB status if poll fails
        console.error(
          "[getCampaign] Meta status poll failed:",
          pollErr.message,
        );
      }
    }

    // ── Live send-progress refresh while SCHEDULED ───────────────────
    if (campaign.status === "SCHEDULED" && campaign.id) {
      try {
        const { rows } = await listScheduledMessages({
          batchId: campaign.id,
          limit: 200,
        });
        let sentCount = 0,
          failedCount = 0,
          pendingCount = 0;
        const smStatusMap = new Map();
        for (const row of rows) {
          smStatusMap.set(row.sm_id, row);
          if (row.status === "sent") sentCount++;
          else if (row.status === "failed") failedCount++;
          else pendingCount++;
        }

        // Update individual recipient rows
        const recipients = campaign.BroadcastRecipient.filter(
          (r) => r.samvaadikSmId && smStatusMap.has(r.samvaadikSmId),
        );
        for (const r of recipients) {
          const sm = smStatusMap.get(r.samvaadikSmId);
          if (!sm) continue;
          const newStatus =
            sm.status === "sent"
              ? "SENT"
              : sm.status === "failed"
                ? "FAILED"
                : r.status;
          if (newStatus !== r.status) {
            await prisma.broadcastRecipient.update({
              where: { id: r.id },
              data: {
                status: newStatus,
                sentAt: sm.sent_at ? new Date(sm.sent_at) : null,
                waMessageId: sm.wa_message_id || null,
                errorMessage: sm.error_message || null,
              },
            });
          }
        }

        // Update campaign totals
        await prisma.broadcastCampaign.update({
          where: { id: campaign.id },
          data: {
            sentCount,
            failedCount,
            ...(pendingCount === 0 && {
              status: "COMPLETED",
              completedAt: new Date(),
            }),
          },
        });
        campaign.sentCount = sentCount;
        campaign.failedCount = failedCount;
        if (pendingCount === 0) campaign.status = "COMPLETED";
      } catch (pollErr) {
        console.error(
          "[getCampaign] send-status poll failed:",
          pollErr.message,
        );
      }
    }

    return res.json({ data: campaign });
  } catch (err) {
    console.error("getCampaign error:", err);
    return res.status(500).json({ error: "Failed to fetch campaign" });
  }
}

// ── POST /api/broadcast-campaigns/:id/submit — staff clicks "Confirm & submit to Meta" ─

async function submitCampaign(req, res) {
  const campaignId = req.params.id;
  const staffId = req.staffUser?.id;

  try {
    const campaign = await prisma.broadcastCampaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status !== "DRAFT") {
      return res.status(409).json({
        error: `Cannot submit — campaign is already ${campaign.status}`,
      });
    }

    // ── Build template options ────────────────────────────────────────────
    //
    // Three possible header paths:
    //   NONE  — no header at all
    //   TEXT  — plain text header (already stored in campaign.headerText)
    //   IMAGE — generate a golf scene via Flux 1.1 Pro, upload to Meta, use
    //           the returned headerHandle in the template

    const templateOptions = {
      language: "en_US",
      bodyExamples: ["Friend"],
    };

    if (campaign.footerText) {
      templateOptions.footerText = campaign.footerText;
    }
    if (campaign.buttons && campaign.buttons.length > 0) {
      templateOptions.buttons = campaign.buttons;
    }

    // ── TEXT header ───────────────────────────────────────────────────────
    if (campaign.headerType === "TEXT" && campaign.headerText) {
      templateOptions.headerFormat = "TEXT";
      templateOptions.headerText = campaign.headerText;
    }

    // ── IMAGE header ──────────────────────────────────────────────────────
    else if (campaign.headerType === "IMAGE") {
      console.log(
        `[submitCampaign] IMAGE header requested for campaign "${campaign.name}"`,
      );

      // Step 1: Use pre-generated image if staff already previewed one in the
      // Insights widget (headerImageUrl stored at draft time). This avoids
      // regenerating and ensures the submitted image matches what staff saw.
      // Only regenerate if no preview image was saved.
      let generatedImageUrl = campaign.headerImageUrl || null;

      if (generatedImageUrl) {
        console.log(
          `[submitCampaign] Using pre-generated image from draft: ${generatedImageUrl}`,
        );
      } else {
        console.log(
          `[submitCampaign] No preview image found — generating now via FLUX.2 Pro`,
        );
        // No product titles are persisted on the BroadcastCampaign row (see
        // prisma/schema.prisma), so a cold-regenerate here can only use the
        // generic thematic path, same limitation that existed before this
        // file switched models — staff should normally never hit this,
        // since the preview step in the widget always saves headerImageUrl
        // first.
        // backdropHint = agentPrompt/category only — do NOT append bodyText.
        // The WhatsApp message body is customer-facing copy, not scene
        // direction, and injecting it into the image prompt corrupts
        // generation ("Hi {{1}}, start 2025..." renders as visible text
        // in the scene).
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
            "[submitCampaign] Image generation failed:",
            genErr.message,
          );
          return res.status(500).json({
            error: "Failed to generate header image",
            details: genErr.message,
            hint: "Check REPLICATE_API_TOKEN in .env. The campaign is still a DRAFT — fix the issue and retry.",
          });
        }
      }

      // Step 2: Upload the image URL to Meta via Samvaadik
      // uploadMediaFromUrl returns { mediaId, headerHandle, headerFormat }
      let uploadResult;
      try {
        const fileName = `${campaign.templateName}_header.jpg`;
        uploadResult = await uploadMediaFromUrl({
          url: generatedImageUrl,
          fileName,
          fileType: "image/jpeg",
        });
        console.log(
          `[submitCampaign] Image uploaded to Meta — headerHandle: ${uploadResult.headerHandle}`,
        );
      } catch (uploadErr) {
        console.error(
          "[submitCampaign] Media upload failed:",
          uploadErr.message,
        );
        return res.status(500).json({
          error: "Failed to upload header image to Meta",
          details: uploadErr.message,
          hint: "Image was generated successfully but the Meta upload failed. Retry submission.",
        });
      }

      // Step 3: Ensure the generated URL is stored in DB for reference
      if (!campaign.headerImageUrl) {
        await prisma.broadcastCampaign.update({
          where: { id: campaignId },
          data: { headerImageUrl: generatedImageUrl },
        });
      }

      // Step 4: Pass the header handle into the template
      templateOptions.headerFormat = "IMAGE";
      templateOptions.headerHandle = uploadResult.headerHandle;
      if (uploadResult.mediaId) {
        templateOptions.mediaId = uploadResult.mediaId;
      }
    }

    // ── Create the WhatsApp template on Meta via Samvaadik ────────────────
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

    return res.json({
      success: true,
      message:
        "Template submitted to Meta for approval. Check back in a few minutes.",
      samvaadikWtId: result.wt_id,
      metaStatus: result.status,
    });
  } catch (err) {
    const detail = err.message;
    console.error("submitCampaign error:", detail);
    return res
      .status(500)
      .json({ error: "Failed to submit template to Meta", details: detail });
  }
}

// ── POST /api/broadcast-campaigns/:id/send — staff clicks "Send" after Meta approves ─

async function sendCampaign(req, res) {
  const campaignId = req.params.id;
  const staffId = req.staffUser?.id;

  try {
    const campaign = await prisma.broadcastCampaign.findUnique({
      where: { id: campaignId },
      include: {
        BroadcastRecipient: {
          where: { status: "PENDING" },
          select: { id: true, phone: true, firstName: true, customerId: true },
        },
      },
    });

    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status !== "READY") {
      return res.status(409).json({
        error: `Cannot send — campaign status is ${campaign.status}. It must be READY (Meta-approved).`,
      });
    }
    if (!campaign.samvaadikWtId) {
      return res
        .status(409)
        .json({ error: "No Samvaadik template ID — submit to Meta first." });
    }

    // Re-check consent for every pending recipient (consent may have changed
    // since draft time — customer may have replied STOP in the interim)
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
      if (!c) {
        skipped.push({ id: r.id, reason: "customer_not_found" });
        continue;
      }
      if (c.optedOutAt) {
        skipped.push({ id: r.id, reason: "opted_out" });
        continue;
      }
      if (!c.consentMarketing) {
        skipped.push({ id: r.id, reason: "no_consent" });
        continue;
      }
      eligible.push(r);
    }

    // Mark skipped recipients up front
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
      return res.status(409).json({
        error:
          "No eligible recipients remain — all were skipped due to consent/opt-out changes.",
        skipped: skipped.length,
      });
    }

    // Mark campaign SCHEDULED immediately so the card shows progress
    const sendAt = computeSendTime();
    await prisma.broadcastCampaign.update({
      where: { id: campaignId },
      data: {
        status: "SCHEDULED",
        scheduledFor: sendAt,
        skippedCount: skipped.length,
      },
    });

    await writeAudit(
      "SEND_INITIATED",
      campaignId,
      staffId,
      { status: "READY" },
      {
        status: "SCHEDULED",
        recipients: eligible.length,
        skipped: skipped.length,
      },
    );

    // Fan out scheduling in batches — don't await the whole loop in the HTTP
    // response (Vercel 10s timeout). Respond immediately and run via
    // setImmediate so the response goes out first.
    res.json({
      success: true,
      message: `Scheduling ${eligible.length} messages. The card will show live progress.`,
      scheduled: eligible.length,
      skipped: skipped.length,
      scheduledFor: sendAt.toISOString(),
    });

    // Fan-out (runs after response is sent)
    setImmediate(async () => {
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
                wtId: campaign.samvaadikWtId,
                templateVariables: { 1: r.firstName || "there" },
                scheduledAt: sendAt.toISOString(),
                timezone: TIMEZONE,
                batchId: campaignId, // batch_id = campaign id for easy polling
              });

              await prisma.broadcastRecipient.update({
                where: { id: r.id },
                data: { status: "SCHEDULED", samvaadikSmId: result.sm_id },
              });
              scheduledOk++;
            } catch (err) {
              console.error(
                `[sendCampaign] schedule failed for recipient ${r.id}:`,
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

      // If everything failed at scheduling time, mark campaign FAILED
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
        `[sendCampaign] campaign ${campaignId} fan-out done — ok:${scheduledOk} fail:${scheduledFail}`,
      );
    });
  } catch (err) {
    console.error("sendCampaign error:", err);
    return res
      .status(500)
      .json({ error: "Failed to initiate send", details: err.message });
  }
}

// ── POST /api/broadcast-campaigns/:id/cancel ────────────────────────────────────────

async function cancelCampaign(req, res) {
  const campaignId = req.params.id;
  const staffId = req.staffUser?.id;

  try {
    const campaign = await prisma.broadcastCampaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const nonCancellable = ["COMPLETED", "CANCELLED"];
    if (nonCancellable.includes(campaign.status)) {
      return res
        .status(409)
        .json({ error: `Campaign is already ${campaign.status}` });
    }

    await prisma.broadcastCampaign.update({
      where: { id: campaignId },
      data: { status: "CANCELLED" },
    });

    await writeAudit(
      "CANCELLED",
      campaignId,
      staffId,
      { status: campaign.status },
      { status: "CANCELLED" },
    );

    return res.json({ success: true, message: "Campaign cancelled." });
  } catch (err) {
    console.error("cancelCampaign error:", err);
    return res.status(500).json({ error: "Failed to cancel campaign" });
  }
}

async function createCampaignDraft(req, res) {
  const { name, bodyText, audienceRules, agentPrompt = "" } = req.body;

  if (!name || !bodyText || !audienceRules) {
    return res
      .status(400)
      .json({ error: "name, bodyText, and audienceRules are required" });
  }
  if (!bodyText.startsWith("Hi {{1}},")) {
    return res
      .status(400)
      .json({ error: 'bodyText must start with "Hi {{1}},"' });
  }
  if (bodyText.length > 1024) {
    return res
      .status(400)
      .json({ error: "bodyText is too long (max 1024 chars)" });
  }

  try {
    const {
      buildAudience,
      MAX_AUDIENCE,
    } = require("../services/broadcastAudienceService");
    const audienceResult = await buildAudience(audienceRules);

    if (audienceResult.customers.length === 0) {
      return res.status(400).json({
        error: "No eligible customers match these rules.",
        excludedNoConsent: audienceResult.excludedNoConsent,
        excludedOptedOut: audienceResult.excludedOptedOut,
      });
    }

    const baseName = name
      .toLowerCase()
      .replace(/\s+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 40);
    const templateName = `${baseName}_${Date.now()}`;

    const campaign = await prisma.$transaction(async (tx) => {
      const c = await tx.broadcastCampaign.create({
        data: {
          name,
          templateName,
          bodyText,
          audienceRules,
          audienceSize: audienceResult.customers.length,
          agentPrompt,
          createdByStaffId: req.staffUser?.id || null,
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

    res.json({
      campaignId: campaign.id,
      campaignName: campaign.name,
      templateName: campaign.templateName,
      audienceSize: audienceResult.customers.length,
      bodyText: campaign.bodyText,
    });
  } catch (err) {
    console.error("createCampaignDraft error:", err);
    res.status(500).json({ error: "Failed to create campaign draft" });
  }
}

async function updateCampaignTemplate(req, res) {
  const campaignId = req.params.id;
  const {
    bodyText,
    headerType,
    headerText,
    headerImageUrl,
    footerText,
    buttons,
    // Cost of the AI image generation call — passed by the frontend after a
    // successful previewCampaignImage call so it can be persisted alongside
    // the image URL. Null/absent for RAW_PHOTO mode or TEXT header campaigns.
    imageGenCostUsd,
    imageGenCostInr,
  } = req.body;

  try {
    const campaign = await prisma.broadcastCampaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status !== "DRAFT") {
      return res.status(409).json({
        error: `Cannot edit template — campaign is ${campaign.status}, not DRAFT`,
      });
    }

    if (bodyText !== undefined) {
      if (!bodyText.startsWith("Hi {{1}},")) {
        return res
          .status(400)
          .json({ error: 'bodyText must start with "Hi {{1}},"' });
      }
      if (bodyText.length > 1024) {
        return res
          .status(400)
          .json({ error: "bodyText is too long (max 1024 chars)" });
      }
    }

    const updated = await prisma.broadcastCampaign.update({
      where: { id: campaignId },
      data: {
        ...(bodyText !== undefined && { bodyText }),
        ...(headerType !== undefined && { headerType }),
        ...(headerText !== undefined && { headerText }),
        ...(headerImageUrl !== undefined && { headerImageUrl }),
        ...(footerText !== undefined && { footerText }),
        ...(buttons !== undefined && { buttons }),
        // Store image generation cost when provided (AI_SCENE mode only).
        // Only written when the frontend explicitly passes both fields — a
        // partial update (e.g. editing bodyText) must not overwrite a cost
        // already saved from a prior previewCampaignImage call.
        ...(imageGenCostUsd != null && { imageGenCostUsd }),
        ...(imageGenCostInr != null && { imageGenCostInr }),
      },
    });

    return res.json({ success: true, campaign: updated });
  } catch (err) {
    console.error("updateCampaignTemplate error:", err);
    return res.status(500).json({ error: "Failed to update template" });
  }
}

// ── POST /api/broadcast-campaigns/preview-image ────────────────────────────────────────
//
// Generates a preview image for the Insights widget picker — called when staff
// selects an IMAGE variant so they can see the image before saving the draft.
// Returns { imageUrl, prompt } — does NOT write to DB.
// The frontend saves the URL via updateCampaignTemplate after the draft is created.

async function previewCampaignImage(req, res) {
  const {
    campaignName,
    intent,
    context,
    headerImagePromptHint,
    headerImageEyebrow,
    headerImageHeadline,
    headerImageBadgeText,
    headerImageProductTitles,
    // Exactly two values now (see STEP 2.6 in insightsAgentConfig.js):
    //   "RAW_PHOTO" — no AI anywhere, the real catalog photo as-is.
    //   "AI_SCENE" (default) — one AI generation call does everything:
    //     scene, product (via reference image when a real photo is
    //     confirmed), and wording, in a single pass.
    imageMode,
    // RAW_PHOTO only: which of the matched product's real catalog photos
    // to use (Product.imageUrls can hold several). Lets staff switch
    // between their own real photos in the picker UI ("Photo 1/3" style),
    // rather than always only ever seeing imageUrls[0]. Ignored for
    // AI_SCENE and for any product that only has one photo.
    selectedProductImageIndex = 0,
  } = req.body;

  if (!campaignName && !intent && !headerImagePromptHint) {
    return res.status(400).json({
      error:
        "At least one of campaignName, intent, or headerImagePromptHint is required",
    });
  }

  try {
    // Use the agent's hint as intent if provided — it's more specific than
    // the general campaign intent (e.g. "championship golf course golden hour"
    // vs just "EVENT")
    const effectiveIntent = headerImagePromptHint || intent || campaignName;
    const usingRawPhoto = imageMode === "RAW_PHOTO";

    // ── Real, named product confirmed (STEP 2.5 in insightsAgentConfig.js) ──
    //
    // If the agent passed confirmed catalog product titles (check_product_photo
    // already ran per product), resolve them to real photo URLs here. This is
    // a SECOND, deterministic exact-title lookup — no re-fuzzy-matching —
    // same "can't drift apart" principle as matchProductImage.
    if (
      Array.isArray(headerImageProductTitles) &&
      headerImageProductTitles.length > 0
    ) {
      const resolvedPhotos = await getProductPhotosByTitles(
        headerImageProductTitles,
      );
      const matchedProductTitles = resolvedPhotos.map((p) => p.title);
      const unmatchedProductTitles = headerImageProductTitles.filter(
        (t) => !matchedProductTitles.includes(t),
      );

      if (resolvedPhotos.length > 0) {
        console.log(
          `[previewCampaignImage] ${
            usingRawPhoto
              ? "Raw-photo (no AI)"
              : "AI-generated (real photo as reference)"
          } for "${campaignName}" — ` +
            `matched: ${matchedProductTitles.join(", ")}` +
            (unmatchedProductTitles.length
              ? ` — unmatched (no longer found, will be skipped): ${unmatchedProductTitles.join(", ")}`
              : ""),
        );

        const generate = usingRawPhoto
          ? generateRawProductCampaignImage
          : generateAIComposedCampaignImage;

        // RAW_PHOTO only: let staff switch which of the FIRST matched
        // product's real catalog photos gets used (Product.imageUrls can
        // hold several — e.g. front/back/in-hand shots). Scoped to the
        // first product deliberately: a multi-product campaign uses all of
        // them together, and "switch photo" for just one of several at once
        // isn't a UI this needs yet — the common, tested case is a single
        // named product.
        let productPhotosForGenerate = resolvedPhotos;
        if (usingRawPhoto && resolvedPhotos[0]?.imageUrls?.length > 1) {
          const idx = Number.isInteger(selectedProductImageIndex)
            ? selectedProductImageIndex
            : 0;
          const clampedIdx = Math.max(
            0,
            Math.min(idx, resolvedPhotos[0].imageUrls.length - 1),
          );
          productPhotosForGenerate = [
            {
              ...resolvedPhotos[0],
              imageUrl: resolvedPhotos[0].imageUrls[clampedIdx],
            },
            ...resolvedPhotos.slice(1),
          ];
        }

        const {
          imageUrl,
          prompt,
          costUsd = null,
          costInr = null,
          inputTokens: imgInputTokens = 0,
          outputTokens: imgOutputTokens = 0,
          model: imgModel = null,
        } = await generate({
          campaignName: campaignName || "Golf Campaign",
          backdropHint: effectiveIntent,
          headline: headerImageHeadline || null,
          eyebrow: headerImageEyebrow || null,
          badgeText: headerImageBadgeText || null,
          productPhotos: productPhotosForGenerate,
        });

        if (!usingRawPhoto && costUsd != null) {
          prisma.insightsUsage
            .create({
              data: {
                staffUserId: null,
                question: `gpt-image-2: ${campaignName || "campaign"}`,
                model: imgModel || "gpt-image-2-2026-04-21",
                inputTokens: imgInputTokens,
                outputTokens: imgOutputTokens,
                costUsd,
                costInr: costInr || 0,
                toolCallCount: 0,
                outcome: "completed",
              },
            })
            .catch((err) =>
              console.error(
                "[previewCampaignImage] usage log failed:",
                err.message,
              ),
            );
        }

        return res.json({
          imageUrl,
          prompt,
          imageMode: usingRawPhoto ? "RAW_PHOTO" : "AI_SCENE",
          // Pass cost back to frontend so it can save alongside headerImageUrl
          imageGenCostUsd: costUsd,
          imageGenCostInr: costInr,
          matchedProductTitles,
          unmatchedProductTitles,
          // RAW_PHOTO + the first matched product has more than one real
          // photo on file — the frontend uses this to show a "Photo 1/3"
          // switcher instead of (not alongside) the AI "Generate new
          // image" button, which doesn't apply to this path at all.
          availableProductImages:
            usingRawPhoto && resolvedPhotos[0]?.imageUrls?.length > 1
              ? resolvedPhotos[0].imageUrls
              : null,
          selectedProductImageIndex: usingRawPhoto
            ? Math.max(
                0,
                Math.min(
                  Number.isInteger(selectedProductImageIndex)
                    ? selectedProductImageIndex
                    : 0,
                  (resolvedPhotos[0]?.imageUrls?.length || 1) - 1,
                ),
              )
            : null,
        });
      }

      // Every title the agent passed failed to resolve (e.g. archived
      // between check_product_photo and now). This used to fall through
      // silently to a fully AI-generated image — a staff member would see
      // a normal-looking preview with zero signal that their real product
      // was never used, found only by reading backend logs after the fact.
      // Per the explicit product decision on this (stop and tell staff,
      // not auto-fallback), return a clear, structured error instead so
      // the frontend can show "couldn't find a photo for X" with a real
      // choice — retry, pick a different product, or knowingly proceed
      // AI-only — rather than a silent swap.
      console.warn(
        `[previewCampaignImage] None of the confirmed product titles resolved to a photo — ` +
          `stopping rather than silently falling back. Titles: ${headerImageProductTitles.join(", ")}`,
      );
      return res.status(409).json({
        error: "PRODUCT_PHOTOS_UNRESOLVED",
        message:
          "Couldn't find a usable photo for any of the confirmed product(s) — " +
          "it may have been archived or removed since this campaign was set up.",
        unmatchedProductTitles: headerImageProductTitles,
      });
    }

    // ── No specific named product — generic thematic AI image ───────────
    //
    // RAW_PHOTO has no meaning with nothing to show "raw," so this is
    // always the AI_SCENE path regardless of what imageMode the caller sent.
    //
    // backdropHint = effectiveIntent only — do NOT append context (the
    // campaign body text). The body text ("Hi {{1}}, start 2025 with your
    // dream clubs...") is WhatsApp message copy, not image-scene direction,
    // and appending it to the prompt corrupts image generation: the model
    // tries to render the message text as part of the scene.
    // The agent's headerImagePromptHint already contains all the scene
    // description needed ("golf clubs arranged on dark slate, gold confetti,
    // New Year mood") — context adds nothing useful here.
    console.log(
      `[previewCampaignImage] Generating preview for "${campaignName}" — hint: "${effectiveIntent}"` +
        (headerImageHeadline ? ` — headline: "${headerImageHeadline}"` : ""),
    );

    const {
      imageUrl,
      prompt,
      costUsd = null,
      costInr = null,
      inputTokens: imgInputTokens = 0,
      outputTokens: imgOutputTokens = 0,
      model: imgModel = null,
    } = await generateAIComposedCampaignImage({
      campaignName: campaignName || "Golf Campaign",
      backdropHint: effectiveIntent,
      headline: headerImageHeadline || null,
      eyebrow: headerImageEyebrow || null,
      badgeText: headerImageBadgeText || null,
    });

    if (costUsd != null) {
      prisma.insightsUsage
        .create({
          data: {
            staffUserId: null,
            question: `gpt-image-2: ${campaignName || "campaign"}`,
            model: imgModel || "gpt-image-2-2026-04-21",
            inputTokens: imgInputTokens,
            outputTokens: imgOutputTokens,
            costUsd,
            costInr: costInr || 0,
            toolCallCount: 0,
            outcome: "completed",
          },
        })
        .catch((err) =>
          console.error(
            "[previewCampaignImage] usage log failed:",
            err.message,
          ),
        );
    }

    return res.json({
      imageUrl,
      prompt,
      imageMode: "AI_SCENE",
      imageGenCostUsd: costUsd,
      imageGenCostInr: costInr,
    });
  } catch (err) {
    // Flux's brand/logo IP-protection filter blocked this specific request
    // (see the matching throw in imageGenerationService.js) — not a generic
    // failure, so give the frontend a distinct, actionable code instead of
    // a flat 500. Same "tell the staff member directly" principle as
    // PRODUCT_PHOTOS_UNRESOLVED above: the fix here (switch to RAW_PHOTO)
    // is known and reliable, so say so rather than making staff guess.
    if (err.code === "AI_BRAND_LOGO_BLOCKED") {
      console.error(
        "[previewCampaignImage] AI_BRAND_LOGO_BLOCKED:",
        err.message,
      );
      return res.status(409).json({
        error: "AI_BRAND_LOGO_BLOCKED",
        message:
          "AI generation was blocked for this branded product. Switch to the raw-photo " +
          "(no AI) option, which uses your real catalog photo exactly.",
        productNames: err.productNames || [],
      });
    }
    console.error("[previewCampaignImage] error:", err.message);
    return res.status(500).json({
      error: "Failed to generate preview image",
      details: err.message,
      hint: "Check OPENAI_API_KEY in .env",
    });
  }
}

// ── POST /api/broadcast-campaigns/resolve-product-image ────────────────────
//
// Path A of the header-image flow: before ever calling Replicate, check
// whether the campaign is actually about one named, real product already
// in the catalog. If so, we use its real photo (Product.imageUrls) instead
// of generating anything — same "never show a customer something
// unverified" principle already used for DynamicTemplate.imageUrl.
//
// The actual matching logic lives in productImageMatchService.js, shared
// with the Insights agent's own check_product_photo tool, so the widget's
// preview and the agent's upfront "I couldn't find that product" check can
// never give two different answers for the same query.
async function resolveProductImage(req, res) {
  const { query } = req.body;

  console.log(`[resolveProductImage] called with query="${query}"`);

  if (!query || !query.trim()) {
    return res.status(400).json({ error: "query is required" });
  }

  try {
    const result = await matchProductImage(query);
    return res.json(result);
  } catch (err) {
    console.error("resolveProductImage error:", err);
    return res.status(500).json({ error: "Failed to look up product image" });
  }
}

async function scheduleCampaign(req, res) {
  const campaignId = req.params.id;
  const staffId = req.staffUser?.id;
  const { scheduledAt } = req.body;

  // ── Validate the timestamp ─────────────────────────────────────────────
  if (!scheduledAt) {
    return res
      .status(400)
      .json({ error: "scheduledAt is required (ISO 8601)" });
  }
  const sendAt = new Date(scheduledAt);
  if (isNaN(sendAt.getTime())) {
    return res.status(400).json({ error: "scheduledAt is not a valid date" });
  }
  if (sendAt <= new Date()) {
    return res.status(400).json({ error: "scheduledAt must be in the future" });
  }

  // ── Respect quiet hours: if the chosen time falls in 21:00–08:00 IST,
  //    push it to 08:00 IST on the appropriate day and warn the staff.
  let effectiveSendAt = sendAt;
  let quietHoursAdjusted = false;
  const chosenHour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE,
      hour: "numeric",
      hour12: false,
    })
      .formatToParts(sendAt)
      .find((p) => p.type === "hour").value,
  );
  if (chosenHour >= QUIET_HOURS_START || chosenHour < QUIET_HOURS_END) {
    effectiveSendAt = new Date(sendAt);
    if (chosenHour >= QUIET_HOURS_START) {
      effectiveSendAt.setDate(effectiveSendAt.getDate() + 1);
    }
    effectiveSendAt.setHours(QUIET_HOURS_END, 0, 0, 0);
    quietHoursAdjusted = true;
    console.log(
      `[scheduleCampaign] Chosen time ${sendAt.toISOString()} is in quiet hours — adjusted to ${effectiveSendAt.toISOString()}`,
    );
  }

  try {
    // ── Load campaign + pending recipients ────────────────────────────────
    const campaign = await prisma.broadcastCampaign.findUnique({
      where: { id: campaignId },
      include: {
        BroadcastRecipient: {
          where: { status: "PENDING" },
          select: { id: true, phone: true, firstName: true, customerId: true },
        },
      },
    });

    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status !== "READY") {
      return res.status(409).json({
        error: `Cannot schedule — campaign status is ${campaign.status}. It must be READY (Meta-approved).`,
      });
    }
    if (!campaign.samvaadikWtId) {
      return res.status(409).json({
        error: "No Samvaadik template ID — submit to Meta first.",
      });
    }

    // ── Re-check consent (same as sendCampaign — consent may have changed) ─
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
      if (!c) {
        skipped.push({ id: r.id, reason: "customer_not_found" });
        continue;
      }
      if (c.optedOutAt) {
        skipped.push({ id: r.id, reason: "opted_out" });
        continue;
      }
      if (!c.consentMarketing) {
        skipped.push({ id: r.id, reason: "no_consent" });
        continue;
      }
      eligible.push(r);
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
      return res.status(409).json({
        error:
          "No eligible recipients remain — all were skipped due to consent/opt-out changes.",
        skipped: skipped.length,
      });
    }

    // ── Mark SCHEDULED immediately so the UI updates ──────────────────────
    await prisma.broadcastCampaign.update({
      where: { id: campaignId },
      data: {
        status: "SCHEDULED",
        scheduledFor: effectiveSendAt,
        skippedCount: skipped.length,
      },
    });

    await writeAudit(
      "SCHEDULE_INITIATED",
      campaignId,
      staffId,
      { status: "READY" },
      {
        status: "SCHEDULED",
        scheduledFor: effectiveSendAt.toISOString(),
        recipients: eligible.length,
        skipped: skipped.length,
        quietHoursAdjusted,
      },
    );

    // ── Respond immediately — fan-out runs after ──────────────────────────
    res.json({
      success: true,
      message: `Scheduled ${eligible.length} messages for ${effectiveSendAt.toISOString()}.`,
      scheduled: eligible.length,
      skipped: skipped.length,
      scheduledFor: effectiveSendAt.toISOString(),
      ...(quietHoursAdjusted && {
        warning: `Your chosen time was in quiet hours (${QUIET_HOURS_START}:00–${QUIET_HOURS_END}:00 IST). Send time moved to ${effectiveSendAt.toLocaleString("en-IN", { timeZone: TIMEZONE })}.`,
      }),
    });

    // ── Fan-out: call Samvaadik for each recipient with scheduled_at ──────
    //    Samvaadik queues the message and fires it at effectiveSendAt.
    //    No polling loop, no PENDING_SCHEDULE, no cron needed.
    setImmediate(async () => {
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
                wtId: campaign.samvaadikWtId,
                templateVariables: { 1: r.firstName || "there" },
                scheduledAt: effectiveSendAt.toISOString(), // ← Samvaadik holds this
                timezone: TIMEZONE,
                batchId: campaignId,
              });

              await prisma.broadcastRecipient.update({
                where: { id: r.id },
                data: { status: "SCHEDULED", samvaadikSmId: result.sm_id },
              });
              scheduledOk++;
            } catch (err) {
              console.error(
                `[scheduleCampaign] Samvaadik call failed for recipient ${r.id}:`,
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
        `[scheduleCampaign] campaign ${campaignId} fan-out done — ok:${scheduledOk} fail:${scheduledFail} scheduledFor:${effectiveSendAt.toISOString()}`,
      );
    });
  } catch (err) {
    console.error("scheduleCampaign error:", err);
    return res
      .status(500)
      .json({ error: "Failed to schedule campaign", details: err.message });
  }
}

module.exports = {
  listCampaigns,
  getCampaign,
  submitCampaign,
  sendCampaign,
  scheduleCampaign,
  cancelCampaign,
  createCampaignDraft,
  updateCampaignTemplate,
  previewCampaignImage,
  resolveProductImage,
};
