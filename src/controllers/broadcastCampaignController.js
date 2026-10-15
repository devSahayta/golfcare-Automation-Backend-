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
const { generateCampaignImage } = require("../services/imageGenerationService");

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
          `[submitCampaign] No preview image found — generating now via Flux 1.1 Pro`,
        );
        const intent =
          campaign.agentPrompt || campaign.category || "golf campaign";
        const context = campaign.bodyText
          ? campaign.bodyText.slice(0, 200)
          : "";

        try {
          const { imageUrl } = await generateCampaignImage({
            campaignName: campaign.name,
            intent,
            context,
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
  const { campaignName, intent, context, headerImagePromptHint } = req.body;

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

    console.log(
      `[previewCampaignImage] Generating preview for "${campaignName}" — hint: "${effectiveIntent}"`,
    );

    const { imageUrl, prompt } = await generateCampaignImage({
      campaignName: campaignName || "Golf Campaign",
      intent: effectiveIntent,
      context: context || "",
    });

    return res.json({ imageUrl, prompt });
  } catch (err) {
    console.error("[previewCampaignImage] error:", err.message);
    return res.status(500).json({
      error: "Failed to generate preview image",
      details: err.message,
      hint: "Check REPLICATE_API_TOKEN in .env",
    });
  }
}

module.exports = {
  listCampaigns,
  getCampaign,
  submitCampaign,
  sendCampaign,
  cancelCampaign,
  createCampaignDraft,
  updateCampaignTemplate,
  previewCampaignImage,
};
