// src/services/emailService.js
//
// Module 5.2 — sends the ProductDraft approval email via Resend. The
// emailed link lands on a safe GET confirmation page (no mutation) with
// two POST-submitting buttons, not a direct approve/reject GET link —
// see productDraftController.js's header for why (email link prefetching
// by security scanners would otherwise auto-approve drafts nobody looked at).

const { Resend } = require("resend");
const { env } = require("../config/env");

let client = null;
function getClient() {
  if (!env.email.providerApiKey) {
    throw new Error("Missing EMAIL_PROVIDER_API_KEY env var.");
  }
  if (!client) client = new Resend(env.email.providerApiKey);
  return client;
}

function escapeHtml(str) {
  return String(str ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/**
 * @param {object} input
 * @param {string} input.token - ProductDraft.approvalToken
 * @param {string} input.title
 * @param {number} input.price
 * @param {string} [input.category]
 * @param {string} [input.specs]
 * @param {string} [input.brand]
 * @param {string} [input.sku]
 * @param {{name: string, value: string}[]} [input.variantOptions]
 * @param {string} [input.imageUrl]
 * @param {"SUPPLIER_PROVIDED"|"WEB_SCRAPED"} input.sourceType
 * @param {string} [input.supplierName]
 */
async function sendProductDraftApprovalEmail({
  token,
  title,
  price,
  category,
  specs,
  brand,
  sku,
  variantOptions,
  imageUrl,
  sourceType,
  supplierName,
}) {
  if (!env.staffApprovalEmail) {
    throw new Error("Missing STAFF_APPROVAL_EMAIL env var.");
  }

  const reviewUrl = `${env.approvalLinkBaseUrl}/api/product-drafts/${token}`;
  const sourceLabel =
    sourceType === "WEB_SCRAPED"
      ? "Sourced from a web search — unverified, please check before approving"
      : `Provided directly by ${supplierName || "the supplier"}`;

  const detailBits = [
    brand,
    sku ? `SKU ${sku}` : null,
    ...(variantOptions || []).map((o) => `${o.name}: ${o.value}`),
  ].filter(Boolean);

  const html = `
    <div style="font-family: sans-serif; max-width: 480px;">
      <h2>New product pending approval</h2>
      <p><strong>${escapeHtml(title)}</strong></p>
      <p>₹${escapeHtml(price)}${category ? ` · ${escapeHtml(category)}` : ""}</p>
      ${detailBits.length ? `<p style="color:#444;">${escapeHtml(detailBits.join(" · "))}</p>` : ""}
      ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" style="max-width:100%;border-radius:8px;" />` : ""}
      ${specs ? `<p>${escapeHtml(specs)}</p>` : ""}
      <p style="color:#666;font-size:13px;">${escapeHtml(sourceLabel)}</p>
      <p>
        <a href="${reviewUrl}" style="display:inline-block;padding:10px 20px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">
          Review this product
        </a>
      </p>
    </div>
  `;

  const resend = getClient();
  await resend.emails.send({
    from: env.email.fromAddress,
    to: [env.staffApprovalEmail],
    subject: `Approve new product: ${title}`,
    html,
  });

  return { sentTo: env.staffApprovalEmail };
}

module.exports = { sendProductDraftApprovalEmail };
