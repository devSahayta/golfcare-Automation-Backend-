// src/controllers/broadcastCampaignController.js
//
// REST endpoints for the broadcast campaign card in the Insights widget.
// The agent creates DRAFT rows, and — as of the schedule_campaign_broadcast
// tool (see insightsAgentTools.js) — can also submit a draft to Meta and
// lock in a staff-requested send time on the staff member's explicit
// verbal confirmation, the same way save_campaign_draft already acts on a
// verbal "save it". "Send now" and "cancel" are still button-only from the
// dashboard; the agent never sends or cancels.
//
// Flow:
//   DRAFT ──(POST /submit, or the agent)──► SUBMITTED ──(Meta approves)──► READY
//   READY ──(POST /send)────► SCHEDULED ──(Samvaadik delivers)──► COMPLETED
//   DRAFT ──(agent: schedule_campaign_broadcast)──► PENDING_SCHEDULE
//     ──(Meta approves, picked up by the scheduler's broadcastSchedulePoll
//        job — see golfcare-scheduler/src/jobs/broadcastSchedulePoll.js)──►
//     SCHEDULED ──(Samvaadik delivers)──► COMPLETED
//   Any non-COMPLETED ──(POST /cancel)──► CANCELLED
//
// Status is polled by the frontend card via GET /:id, which still does a
// live Meta/send-status check on each view — but that's no longer the
// only thing advancing a campaign. A campaign sitting in SUBMITTED or
// PENDING_SCHEDULE with nobody watching the dashboard (the whole point of
// scheduling by voice through the agent) is now also advanced by the
// scheduler's background poll, same pattern templateStatusPoll.js already
// uses for DynamicTemplate.

const { waitUntil } = require("@vercel/functions");
const { prisma } = require("../lib/prisma");
const {
  getTemplateStatus,
  listScheduledMessages,
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
const {
  submitBroadcastCampaignToMeta,
  SubmitError,
} = require("../services/broadcastSubmitService");
const {
  prepareFanOut,
  fanOutBroadcastCampaign,
  prepareRetry,
  retryFailedRecipients,
} = require("../services/broadcastFanOutService");

const TIMEZONE = process.env.SCHEDULER_TIMEZONE || "Asia/Kolkata";
const QUIET_HOURS_START = Number(process.env.CAMPAIGN_QUIET_HOURS_START ?? 21);
const QUIET_HOURS_END = Number(process.env.CAMPAIGN_QUIET_HOURS_END ?? 8);

// ── helpers ──────────────────────────────────────────────────────────────

// function sleep(ms) {
//   return new Promise((r) => setTimeout(r, ms));
// }

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
            retryCount: true, // ← surfaced so the UI can show "Retried 2/3" / "limit reached"
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    // ── Live Meta approval check while SUBMITTED ──────────────────────
    if (campaign.status === "SUBMITTED" && campaign.samvaadikWtId) {
      try {
        // Short timeout here — this call runs synchronously inside a
        // Vercel request handler the dashboard polls every 6s. 5s leaves
        // headroom under Vercel's 10s function limit for the DB writes and
        // response below; a slow/hung Samvaadik just means this poll tick
        // falls through to the catch and returns last-known DB state
        // instead of risking a platform-level 504.
        const tplStatus = await getTemplateStatus(campaign.samvaadikWtId, {
          timeoutMs: 5000,
        });
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
        // Same reasoning as the getTemplateStatus call above — short
        // timeout so a slow Samvaadik degrades to "stale but correct" data
        // instead of risking Vercel killing the whole function at 10s.
        const { rows } = await listScheduledMessages({
          batchId: campaign.id,
          limit: 200,
          timeoutMs: 5000,
        });
        const smStatusMap = new Map();
        for (const row of rows) smStatusMap.set(row.sm_id, row);

        // Update individual recipient rows — scoped to each recipient's
        // OWN current samvaadikSmId only, so an older superseded sm_id
        // from a previous failed attempt is never looked at here.
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

        // Recompute totals from the DB's current recipient rows, NOT from
        // the raw Samvaadik batch list above. retryFailedRecipients reuses
        // the same batchId (=campaignId) on every retry, and Samvaadik's
        // /v1/messages/schedule?batch_id=... list keeps returning entries
        // from EARLIER, now-superseded attempts too — summing those raw
        // rows meant a retried campaign could carry a phantom "pending"
        // forever and never reach pendingCount === 0, exactly what you're
        // seeing stuck on SCHEDULED. Counting DB status instead only ever
        // reflects each recipient's current attempt (already updated
        // above), so a retry can never leave a stale pending behind. Same
        // pattern the scheduler's pollBroadcastSendStatus already uses.
        const [sentCount, failedCount, pendingCount] = await Promise.all([
          prisma.broadcastRecipient.count({
            where: { campaignId: campaign.id, status: "SENT" },
          }),
          prisma.broadcastRecipient.count({
            where: { campaignId: campaign.id, status: "FAILED" },
          }),
          prisma.broadcastRecipient.count({
            where: { campaignId: campaign.id, status: "SCHEDULED" },
          }),
        ]);

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
    const result = await submitBroadcastCampaignToMeta(campaignId, { staffId });
    return res.json({
      success: true,
      message:
        "Template submitted to Meta for approval. Check back in a few minutes.",
      samvaadikWtId: result.samvaadikWtId,
      metaStatus: result.metaStatus,
    });
  } catch (err) {
    console.error("submitCampaign error:", err.message);
    if (err instanceof SubmitError) {
      return res.status(err.status).json({
        error: err.message,
        ...(err.hint && { hint: err.hint }),
      });
    }
    return res.status(500).json({
      error: "Failed to submit template to Meta",
      details: err.message,
    });
  }
}

// ── POST /api/broadcast-campaigns/:id/send — staff clicks "Send" after Meta approves ─

async function sendCampaign(req, res) {
  const campaignId = req.params.id;
  const staffId = req.staffUser?.id;

  try {
    const campaign = await prisma.broadcastCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status !== "READY") {
      return res.status(409).json({
        error: `Cannot send — campaign status is ${campaign.status}. It must be READY (Meta-approved).`,
      });
    }

    const sendAt = computeSendTime();
    const prep = await prepareFanOut({
      campaignId,
      sendAt,
      timezone: TIMEZONE,
      auditAction: "SEND_INITIATED",
      staffId,
    });
    if (!prep.ok) {
      return res.status(prep.status).json({
        error: prep.error,
        ...(prep.skipped != null && { skipped: prep.skipped }),
      });
    }

    // Respond immediately — the actual fan-out (one Samvaadik call per
    // recipient, batched) runs after, via waitUntil() so Vercel keeps this
    // invocation alive without holding up the response. See
    // broadcastFanOutService.js for why plain setImmediate() isn't safe
    // here.
    res.json({
      success: true,
      message: `Scheduling ${prep.eligible.length} messages. The card will show live progress.`,
      scheduled: prep.eligible.length,
      skipped: prep.skipped,
      scheduledFor: sendAt.toISOString(),
    });

    waitUntil(
      fanOutBroadcastCampaign({
        campaignId,
        samvaadikWtId: prep.samvaadikWtId,
        eligible: prep.eligible,
        sendAt,
        timezone: TIMEZONE,
      }),
    );
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
    const campaign = await prisma.broadcastCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });
    if (campaign.status !== "READY") {
      return res.status(409).json({
        error: `Cannot schedule — campaign status is ${campaign.status}. It must be READY (Meta-approved).`,
      });
    }

    const prep = await prepareFanOut({
      campaignId,
      sendAt: effectiveSendAt,
      timezone: TIMEZONE,
      auditAction: "SCHEDULE_INITIATED",
      staffId,
    });
    if (!prep.ok) {
      return res.status(prep.status).json({
        error: prep.error,
        ...(prep.skipped != null && { skipped: prep.skipped }),
      });
    }

    // ── Respond immediately — fan-out runs after, via waitUntil() (see
    //    broadcastFanOutService.js) so Vercel can't freeze this instance
    //    mid-loop the way a bare setImmediate() risked. ──────────────────
    res.json({
      success: true,
      message: `Scheduled ${prep.eligible.length} messages for ${effectiveSendAt.toISOString()}.`,
      scheduled: prep.eligible.length,
      skipped: prep.skipped,
      scheduledFor: effectiveSendAt.toISOString(),
      ...(quietHoursAdjusted && {
        warning: `Your chosen time was in quiet hours (${QUIET_HOURS_START}:00–${QUIET_HOURS_END}:00 IST). Send time moved to ${effectiveSendAt.toLocaleString("en-IN", { timeZone: TIMEZONE })}.`,
      }),
    });

    waitUntil(
      fanOutBroadcastCampaign({
        campaignId,
        samvaadikWtId: prep.samvaadikWtId,
        eligible: prep.eligible,
        sendAt: effectiveSendAt,
        timezone: TIMEZONE,
      }),
    );
  } catch (err) {
    console.error("scheduleCampaign error:", err);
    return res
      .status(500)
      .json({ error: "Failed to schedule campaign", details: err.message });
  }
}

// ── POST /api/broadcast-campaigns/:id/retry — staff clicks "Retry failed messages" ─
//
// Manual only for now (per explicit product decision) — staff reviews the
// failures and decides whether retrying makes sense (a transient Samvaadik
// error) vs. not (an invalid number, which will just fail again). Consent
// is re-checked the same way a fresh send does, since time has passed.

async function retryCampaign(req, res) {
  const campaignId = req.params.id;
  const staffId = req.staffUser?.id;

  try {
    const prep = await prepareRetry({ campaignId, staffId });
    if (!prep.ok) {
      return res.status(prep.status).json({
        error: prep.error,
        ...(prep.skipped != null && { skipped: prep.skipped }),
      });
    }

    const sendAt = computeSendTime();

    // Respond immediately — retry fan-out runs after via waitUntil(), same
    // Vercel-safety reasoning as sendCampaign/scheduleCampaign above.
    res.json({
      success: true,
      message: `Retrying ${prep.eligible.length} failed message(s).`,
      retrying: prep.eligible.length,
      skipped: prep.skipped,
      atRetryCap: prep.atRetryCap,
    });

    waitUntil(
      retryFailedRecipients({
        campaignId,
        samvaadikWtId: prep.samvaadikWtId,
        eligible: prep.eligible,
        sendAt,
        timezone: TIMEZONE,
      }),
    );
  } catch (err) {
    console.error("retryCampaign error:", err);
    return res
      .status(500)
      .json({ error: "Failed to retry campaign", details: err.message });
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
  retryCampaign,
};
