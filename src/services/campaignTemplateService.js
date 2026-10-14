// src/services/campaignTemplateService.js
//
// Module 6 — the one place that decides a DynamicTemplate is approved or
// rejected and, on approval, submits it to Meta via Samvaadik. Called from
// both the emailed-link approval page (dynamicTemplateController.js) and
// the staff dashboard (campaignController.js), so the two paths can never
// drift apart.

const { prisma } = require("../lib/prisma");
const { createTemplate, uploadMediaFromUrl } = require("../lib/samvaadik/adapter");

const EXT_TO_MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
};

function guessImageMimeType(url) {
  const match = /\.([a-z0-9]+)(?:\?|$)/i.exec(url || "");
  return EXT_TO_MIME[match?.[1]?.toLowerCase()] || "image/jpeg";
}

// Best-effort image header. A dead/expired image URL shouldn't lose the
// whole template, just its header — same resilience shape as
// shopifyProductCreate.js's image-then-no-image retry.
async function buildImageHeader(template) {
  if (!template.imageUrl) return {};
  try {
    const upload = await uploadMediaFromUrl({
      url: template.imageUrl,
      fileName: `${template.templateName}.jpg`,
      fileType: guessImageMimeType(template.imageUrl),
    });
    return {
      headerFormat: "IMAGE",
      headerHandle: upload.headerHandle,
      mediaId: upload.mediaId,
    };
  } catch (err) {
    console.error("[campaignTemplateService] image upload failed, submitting as text-only:", err.message);
    return {};
  }
}

// decidedBy is always a human-readable identifier (a staff email, or the
// literal string "EMAIL" from the no-login emailed-link path — see
// dynamicTemplateController.js, which the user asked us not to change).
// actorId is the real StaffUser.id when the dashboard calls this (it has
// req.staffUser available); the email-link path has no logged-in user, so
// it's left null there — AuditLog.actorId is nullable for exactly this.
function logDecisionAudit({ action, templateId, decidedBy, actorId, afterState }) {
  return prisma.auditLog.create({
    data: {
      actorType: "STAFF",
      actorId: actorId || null,
      action,
      entityType: "DynamicTemplate",
      entityId: templateId,
      afterState: { decidedBy, ...afterState },
      source: decidedBy === "EMAIL" ? "dynamic_template_email_link" : "campaign_dashboard",
    },
  });
}

// Throws if the template isn't PENDING anymore, so a double-click or a
// stale email link can't submit the same template to Meta twice.
async function approveAndSubmit(templateId, decidedBy, actorId = null) {
  const template = await prisma.dynamicTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw Object.assign(new Error("not_found"), { status: 404 });
  if (template.internalApprovalStatus !== "PENDING") {
    throw Object.assign(new Error("already_decided"), { status: 409 });
  }

  const variables = Array.isArray(template.variables) ? template.variables : [];
  const headerOptions = await buildImageHeader(template);
  const result = await createTemplate(template.templateName, template.category, template.bodyDraft, {
    bodyExamples: variables,
    ...headerOptions,
  });

  const updated = await prisma.dynamicTemplate.update({
    where: { id: template.id },
    data: {
      internalApprovalStatus: "APPROVED",
      internalApprovedBy: decidedBy,
      internalApprovedAt: new Date(),
      samvaadikWtId: result.wt_id,
      metaStatus: "SUBMITTED",
      metaSubmittedAt: new Date(),
    },
  });
  await logDecisionAudit({
    action: "campaign_template_approved",
    templateId: template.id,
    decidedBy,
    actorId,
    afterState: { samvaadikWtId: result.wt_id },
  });
  return updated;
}

async function reject(templateId, decidedBy, actorId = null) {
  const template = await prisma.dynamicTemplate.findUnique({ where: { id: templateId } });
  if (!template) throw Object.assign(new Error("not_found"), { status: 404 });
  if (template.internalApprovalStatus !== "PENDING") {
    throw Object.assign(new Error("already_decided"), { status: 409 });
  }
  const updated = await prisma.dynamicTemplate.update({
    where: { id: template.id },
    data: {
      internalApprovalStatus: "REJECTED",
      internalApprovedBy: decidedBy,
      internalApprovedAt: new Date(),
    },
  });
  await logDecisionAudit({ action: "campaign_template_rejected", templateId: template.id, decidedBy, actorId });
  return updated;
}

module.exports = { approveAndSubmit, reject };
