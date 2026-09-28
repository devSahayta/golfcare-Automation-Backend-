// controllers/dynamicTemplateController.js
//
// Module 6 approval flow — same shape as productDraftController.js (see
// that file's header for why GET/POST are split: email security scanners
// prefetch links, which would silently auto-approve a draft nobody
// looked at if the GET itself mutated state).
//
// The approvalToken itself is the auth — these routes are intentionally
// public (same reasoning as ProductDraft: single-use, expiring token, no
// StaffUser session tied to it). Validity (exists, still PENDING, not
// expired) is re-checked on the POST independently of what the GET
// rendered.
//
// Approving submits the draft to Meta via createTemplate — already built
// in lib/samvaadik/adapter.js for Module 1, never actually called until
// now. Everything after submission (poll for Meta approval, schedule the
// send, delete once used) is the scheduler's job, not this controller's —
// see golfcare-Automation-Schedular-/src/jobs/templateStatusPoll.js and
// templateDeletionSweep.js.

const { prisma } = require("../lib/prisma");
const { createTemplate } = require("../lib/samvaadik/adapter");

function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function page(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Golf Care — Campaign Template</title>
<style>body{font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#111}
form{display:inline-block;margin-right:8px}
button{padding:10px 20px;border:none;border-radius:6px;font-size:15px;cursor:pointer}
.approve{background:#16a34a;color:#fff} .reject{background:#dc2626;color:#fff}</style>
</head><body>${bodyHtml}</body></html>`;
}

async function loadPendingTemplate(token) {
  const template = await prisma.dynamicTemplate.findUnique({ where: { approvalToken: token } });
  if (!template) return { error: "not_found" };
  if (template.internalApprovalStatus !== "PENDING") return { error: "already_decided", template };
  if (template.tokenExpiresAt && template.tokenExpiresAt < new Date()) return { error: "expired", template };
  return { template };
}

async function showTemplate(req, res) {
  const { token } = req.params;
  const { template, error } = await loadPendingTemplate(token);

  if (error === "not_found") {
    return res.status(404).send(page("<h2>Not found</h2><p>This approval link is invalid.</p>"));
  }
  if (error === "already_decided") {
    return res.send(
      page(`<h2>Already ${escapeHtml(template.internalApprovalStatus.toLowerCase())}</h2><p>This template was already decided on.</p>`),
    );
  }
  if (error === "expired") {
    return res.send(page("<h2>Link expired</h2><p>This approval link has expired.</p>"));
  }

  const variables = Array.isArray(template.variables) ? template.variables : [];
  let previewText = template.bodyDraft;
  variables.forEach((v, i) => {
    previewText = previewText.replace(`{{${i + 1}}}`, String(v));
  });

  res.send(
    page(`
      <h2>New campaign template pending approval</h2>
      <p><strong>${escapeHtml(template.scenario)}</strong> &middot; ${escapeHtml(template.category)}</p>
      <p>${escapeHtml(previewText)}</p>
      <p style="color:#666;font-size:13px;">Template name: ${escapeHtml(template.templateName)}</p>
      <p style="color:#666;font-size:13px;">AI-drafted for one customer, submitted to Meta for approval, sent once, then deleted — not a reusable template.</p>
      <form method="POST" action="/api/dynamic-templates/${encodeURIComponent(token)}/approve">
        <button class="approve" type="submit">Approve &amp; submit to Meta</button>
      </form>
      <form method="POST" action="/api/dynamic-templates/${encodeURIComponent(token)}/reject">
        <button class="reject" type="submit">Reject</button>
      </form>
    `),
  );
}

async function approveTemplate(req, res) {
  const { token } = req.params;
  const { template, error } = await loadPendingTemplate(token);
  if (error) {
    return res.status(error === "not_found" ? 404 : 409).send(page(`<h2>Can't approve</h2><p>${error}</p>`));
  }

  try {
    const variables = Array.isArray(template.variables) ? template.variables : [];
    const result = await createTemplate(template.templateName, template.category, template.bodyDraft, {
      bodyExamples: variables,
    });

    await prisma.dynamicTemplate.update({
      where: { id: template.id },
      data: {
        internalApprovalStatus: "APPROVED",
        internalApprovedBy: "EMAIL",
        internalApprovedAt: new Date(),
        samvaadikWtId: result.wt_id,
        metaStatus: "SUBMITTED",
        metaSubmittedAt: new Date(),
      },
    });

    res.send(
      page(
        "<h2>Submitted to Meta</h2><p>The template is now awaiting Meta's approval — it'll be scheduled and sent automatically once approved.</p>",
      ),
    );
  } catch (err) {
    console.error("[dynamicTemplateController] approve failed:", err.message);
    res
      .status(500)
      .send(page("<h2>Something went wrong</h2><p>Submitting to Meta failed — nothing was changed. Try again shortly.</p>"));
  }
}

async function rejectTemplate(req, res) {
  const { token } = req.params;
  const { template, error } = await loadPendingTemplate(token);
  if (error) {
    return res.status(error === "not_found" ? 404 : 409).send(page(`<h2>Can't reject</h2><p>${error}</p>`));
  }

  await prisma.dynamicTemplate.update({
    where: { id: template.id },
    data: { internalApprovalStatus: "REJECTED", internalApprovedBy: "EMAIL", internalApprovedAt: new Date() },
  });
  res.send(page("<h2>Rejected</h2><p>The draft was left unsubmitted — nothing was sent to the customer.</p>"));
}

module.exports = { showTemplate, approveTemplate, rejectTemplate };
