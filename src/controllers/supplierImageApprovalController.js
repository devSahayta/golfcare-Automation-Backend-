// controllers/supplierImageApprovalController.js
//
// Email-approval flow for SupplierImageSubmission — same split and same
// reasoning as productDraftController.js: GET renders a safe confirmation
// page (no mutation, so email-scanner link prefetching can't auto-approve
// a photo nobody looked at), POST actually decides. The approvalToken
// itself is the auth, same posture as ProductDraft's.
const { prisma } = require("../lib/prisma");
const { approveAndPublish, reject } = require("../services/supplierImageSubmissionService");

function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function page(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Golf Care — Product Photo</title>
<style>body{font-family:sans-serif;max-width:480px;margin:40px auto;padding:0 16px;color:#111}
img{max-width:100%;border-radius:8px} form{display:inline-block;margin-right:8px}
button{padding:10px 20px;border:none;border-radius:6px;font-size:15px;cursor:pointer}
.approve{background:#16a34a;color:#fff} .reject{background:#dc2626;color:#fff}</style>
</head><body>${bodyHtml}</body></html>`;
}

async function loadPendingSubmission(token) {
  const submission = await prisma.supplierImageSubmission.findUnique({
    where: { approvalToken: token },
    include: { Product: true, Supplier: true },
  });
  if (!submission) return { error: "not_found" };
  if (submission.status !== "PENDING") return { error: "already_decided", submission };
  if (submission.tokenExpiresAt < new Date()) return { error: "expired", submission };
  return { submission };
}

async function showSubmission(req, res) {
  const { token } = req.params;
  const { submission, error } = await loadPendingSubmission(token);

  if (error === "not_found") {
    return res.status(404).send(page("<h2>Not found</h2><p>This approval link is invalid.</p>"));
  }
  if (error === "already_decided") {
    return res.send(
      page(`<h2>Already ${escapeHtml(submission.status.toLowerCase())}</h2><p>This photo was already decided on.</p>`),
    );
  }
  if (error === "expired") {
    return res.send(page("<h2>Link expired</h2><p>This approval link has expired.</p>"));
  }

  res.send(
    page(`
      <h2>New product photo pending approval</h2>
      <p><strong>${escapeHtml(submission.Product.title)}</strong></p>
      <p style="color:#666;font-size:13px;">Submitted by ${escapeHtml(submission.Supplier?.name || "a supplier")} — this product currently has no Shopify image.</p>
      <img src="${escapeHtml(submission.imageUrl)}" alt="">
      <form method="POST" action="/api/supplier-image-submissions/${encodeURIComponent(token)}/approve">
        <button class="approve" type="submit">Approve &amp; add to product</button>
      </form>
      <form method="POST" action="/api/supplier-image-submissions/${encodeURIComponent(token)}/reject">
        <button class="reject" type="submit">Reject</button>
      </form>
    `),
  );
}

async function approveSubmission(req, res) {
  const { token } = req.params;
  const { submission, error } = await loadPendingSubmission(token);
  if (error) {
    return res.status(error === "not_found" ? 404 : 409).send(page(`<h2>Can't approve</h2><p>${error}</p>`));
  }

  try {
    await approveAndPublish(submission.id, { approvedVia: "EMAIL" });
    res.send(page("<h2>Approved</h2><p>The photo is now live on the product in Shopify.</p>"));
  } catch (err) {
    console.error("[supplierImageApprovalController] approve failed:", err.response?.data || err.message);
    res.status(500).send(
      page(`<h2>Something went wrong</h2><p>${escapeHtml(err.message || "Adding the photo to Shopify failed — nothing was changed. Try again shortly.")}</p>`),
    );
  }
}

async function rejectSubmission(req, res) {
  const { token } = req.params;
  const { submission, error } = await loadPendingSubmission(token);
  if (error) {
    return res.status(error === "not_found" ? 404 : 409).send(page(`<h2>Can't reject</h2><p>${error}</p>`));
  }

  await reject(submission.id, { approvedVia: "EMAIL" });
  res.send(page("<h2>Rejected</h2><p>The photo was not added to the product.</p>"));
}

module.exports = { showSubmission, approveSubmission, rejectSubmission };
