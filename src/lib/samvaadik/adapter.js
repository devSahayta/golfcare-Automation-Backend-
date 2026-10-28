// src/lib/samvaadik/adapter.js
//
// Duplicated from golfcare-scheduler/src/lib/samvaadik/adapter.js —
// verbatim, same cross-repo duplication reason as client.js above. Keep
// the two in sync manually if the API shape changes.
//
// Only sendText and parseWebhook are actually used by the Sales Agent
// today; the rest are kept so this file matches the scheduler's copy
// exactly rather than silently drifting.

const { callSamvaadik } = require("./client");

/**
 * Send a free-form WhatsApp text message.
 * NOTE: Samvaadik enforces WhatsApp's 24-hour messaging window — this call
 * will fail with a 403 (code NO_USER_REPLY / WINDOW_EXPIRED /
 * TEMPLATE_ONLY_WAITING_FOR_USER) if the contact hasn't messaged recently.
 * Use sendTemplate to initiate or re-open a conversation instead.
 *
 * @param {string} to - phone number, digits only (Samvaadik's own format, e.g. "919876543210")
 * @param {string} body - message text
 * @param {{ skipWindowCheck?: boolean }} [options]
 * @returns {Promise<{ waMessageId: string, wmId: string }>}
 */
async function sendText(to, body, options = {}) {
  return callSamvaadik(async (client) => {
    const headers = options.skipWindowCheck
      ? { "x-skip-window-check": "true" }
      : {};
    const res = await client.post(
      "/messages/text",
      { phone: to, message: body },
      { headers },
    );
    return { waMessageId: res.data.wa_message_id, wmId: res.data.wm_id };
  });
}

/**
 * @param {string} to
 * @param {string} templateName
 * @param {string[]} [variables] - ordered body parameters, matching {{1}}, {{2}}...
 * @param {{ language?: string, headerMediaId?: string }} [options]
 */
async function sendTemplate(to, templateName, variables = [], options = {}) {
  return callSamvaadik(async (client) => {
    const res = await client.post("/messages/template", {
      phone: to,
      template_name: templateName,
      language: options.language || "en_US",
      parameters: variables,
      ...(options.headerMediaId && { header_media_id: options.headerMediaId }),
    });
    return { waMessageId: res.data.wa_message_id, wmId: res.data.wm_id };
  });
}

async function sendInteractive(to, bodyText, buttons) {
  if (!buttons || buttons.length === 0)
    throw new Error("sendInteractive requires at least one button.");
  if (buttons.length > 3)
    throw new Error("WhatsApp allows a maximum of 3 quick-reply buttons.");

  return callSamvaadik(async (client) => {
    const res = await client.post("/messages/interactive", {
      phone: to,
      body_text: bodyText,
      buttons: buttons.map((b) => ({ id: b.id, title: b.label })),
    });
    return { waMessageId: res.data.wa_message_id, wmId: res.data.wm_id };
  });
}

async function createTemplate(name, category, bodyText, options = {}) {
  return callSamvaadik(async (client) => {
    const res = await client.post("/templates", {
      name,
      category,
      language: options.language || "en_US",
      body_text: bodyText,
      body_examples: options.bodyExamples || [],
      ...(options.headerFormat && { header_format: options.headerFormat }),
      ...(options.headerText && { header_text: options.headerText }),
      ...(options.headerHandle && { header_handle: options.headerHandle }),
      ...(options.mediaId && { media_id: options.mediaId }),
      ...(options.footerText && { footer_text: options.footerText }),
      ...(options.buttons && { buttons: options.buttons }),
    });
    return res.data.data;
  });
}

async function listTemplates() {
  return callSamvaadik(async (client) => {
    const res = await client.get("/templates");
    return res.data.data;
  });
}

/**
 * Full detail for one template, including its components (body text,
 * header). The list endpoint returns only summary fields, so use this
 * when the actual message content is needed.
 *
 * @param {string} wtId
 * @returns {Promise<object>} the template row, with components as stored
 */
async function getTemplate(wtId) {
  return callSamvaadik(async (client) => {
    const res = await client.get(`/templates/${wtId}`);
    return res.data.data;
  });
}

/**
 * Upload an image by URL for use as a template's media header — the
 * server fetches the binary itself, no size limit (unlike the
 * multipart /media/upload route, capped at 4.5MB by Vercel). Module 6 —
 * used by dynamicTemplateController.js to give a dynamic template a real
 * image header (the featured product's own Shopify photo, never an
 * AI-generated one) before calling createTemplate with the returned
 * headerHandle/mediaId.
 *
 * @param {object} input
 * @param {string} input.url - publicly accessible image URL
 * @param {string} input.fileName
 * @param {string} input.fileType - MIME type, e.g. "image/jpeg"
 * @returns {Promise<{mediaId: string, headerHandle: string, headerFormat: string}>}
 */
async function uploadMediaFromUrl({ url, fileName, fileType }) {
  return callSamvaadik(async (client) => {
    const res = await client.post("/media/upload-from-url", {
      url,
      file_name: fileName,
      file_type: fileType,
    });
    return {
      mediaId: res.data.media_id,
      headerHandle: res.data.header_handle,
      headerFormat: res.data.header_format,
    };
  });
}

async function downloadMedia(mediaUrl) {
  const axios = require("axios");
  const res = await axios.get(mediaUrl, {
    responseType: "arraybuffer",
    timeout: 20000,
  });
  return Buffer.from(res.data);
}

/**
 * Confirmed real payload shape: [{ event, account_id, from, message,
 * message_type, media_url, timestamp }]. Always an array, even for one
 * event. This is the single source of truth for parsing — the webhook
 * handler should call this instead of normalizing the body itself.
 */
function parseWebhook(rawBody) {
  let parsed;
  try {
    parsed = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
  } catch (err) {
    throw new Error(`parseWebhook: invalid JSON payload: ${err.message}`);
  }

  const events = Array.isArray(parsed) ? parsed : [parsed];

  return events.map((evt) => {
    if (evt.event !== "message.received") {
      console.warn(`parseWebhook: unrecognized event type "${evt.event}"`, evt);
    }
    return {
      event: evt.event,
      accountId: evt.account_id,
      from: evt.from,
      message: evt.message,
      messageType: evt.message_type,
      mediaUrl: evt.media_url || null,
      timestamp: evt.timestamp ? new Date(evt.timestamp) : new Date(),
    };
  });
}

/**
 * Delete a WhatsApp template from Meta and Samvaadik.
 *
 * Confirmed against Samvaadik's real source (publicApiController.js,
 * Sept 2026) — this stub used to throw "blocked, no DELETE endpoint,"
 * which was true when it was written but is stale now; Samvaadik added
 * DELETE /v1/templates/:wt_id since. Samvaadik itself refuses (409,
 * code TEMPLATE_IN_USE) if any scheduled_messages/campaigns row still
 * references this template — callers should only reach this once the
 * template is genuinely done being used (e.g. Module 6's
 * templateDeletionSweep gates on sendStatus === "SENT" before calling
 * this), not rely on the 409 as the only guard.
 *
 * @param {string} wtId - Samvaadik's whatsapp_templates.wt_id
 * @returns {Promise<{wtId: string, name: string, metaDeleted: boolean, localRecordRetained: boolean}>}
 */
async function deleteTemplate(wtId) {
  return callSamvaadik(async (client) => {
    const res = await client.delete(`/templates/${wtId}`);
    return {
      wtId: res.data.data.wt_id,
      name: res.data.data.name,
      metaDeleted: res.data.data.meta_deleted,
      localRecordRetained: res.data.data.local_record_retained,
    };
  });
}

async function getProduct(_shopifyProductId) {
  throw new Error(
    "getProduct is deprecated — Shopify product data comes from golfcare-backend's own Prisma Product table.",
  );
}

async function updateInventory(_variantId, _status, _leadTimeDays) {
  throw new Error(
    "updateInventory is deprecated — handled directly in golfcare-backend (Module 2, AvailabilityService).",
  );
}

async function getOrderStatus(_orderIdOrNumber) {
  throw new Error(
    "getOrderStatus is deprecated — order data comes from golfcare-backend's own Prisma Order table.",
  );
}

async function getTemplateStatus(wtId, { timeoutMs } = {}) {
  return callSamvaadik(
    async (client) => {
      // GET /v1/templates returns only APPROVED templates for this account
      const res = await client.get("/templates");
      const templates = res.data?.data || [];
      const match = templates.find((t) => t.wt_id === wtId);

      if (match) {
        return {
          wtId,
          status: "APPROVED",
          name: match.name,
          metaStatus: match.status,
        };
      }

      // Not in the approved list — could be PENDING or REJECTED.
      // Samvaadik doesn't expose a single-template GET endpoint, so we
      // treat "not found in approved list" as PENDING for polling purposes.
      // The controller will keep polling until it appears or the campaign is
      // manually cancelled.
      return { wtId, status: "PENDING" };
    },
    { timeoutMs },
  );
}

/**
 * Schedule a WhatsApp template message via Samvaadik.
 *
 * POST /v1/messages/schedule
 *
 * @param {object} params
 * @param {string} params.phone           - recipient phone, digits only e.g. "919876543210"
 * @param {string} [params.contactName]   - optional display name
 * @param {string} params.wtId            - Samvaadik template wt_id
 * @param {object} [params.templateVariables] - e.g. { "1": "Rahul" }
 * @param {string} params.scheduledAt     - ISO 8601 datetime string
 * @param {string} [params.timezone]      - e.g. "Asia/Kolkata"
 * @param {string} [params.batchId]       - group related messages, ≤100 chars
 * @param {string} [params.mediaId]       - required only if template has media header
 * @returns {Promise<{ sm_id: string, status: string }>}
 */
async function scheduleTemplateMessage({
  phone,
  contactName,
  wtId,
  templateVariables = {},
  scheduledAt,
  timezone = "Asia/Kolkata",
  batchId,
  mediaId,
}) {
  return callSamvaadik(async (client) => {
    const body = {
      phone,
      wt_id: wtId,
      scheduled_at: scheduledAt,
      timezone,
      template_variables: templateVariables,
      ...(contactName && { contact_name: contactName }),
      ...(batchId && { batch_id: batchId }),
      ...(mediaId && { media_id: mediaId }),
    };

    const res = await client.post("/messages/schedule", body);
    // Response: { success, message, data: { sm_id, status, scheduled_at, ... } }
    return res.data.data;
  });
}

/**
 * List scheduled messages, optionally filtered by batch_id.
 *
 * GET /v1/messages/schedule?batch_id=...&limit=...
 *
 * @param {object} [filters]
 * @param {string} [filters.batchId]   - filter to a specific campaign batch
 * @param {string} [filters.status]    - "scheduled" | "sent" | "failed" | "cancelled"
 * @param {string} [filters.phone]     - filter by recipient phone
 * @param {number} [filters.limit]     - max rows (default 50, max 200)
 * @param {number} [filters.offset]    - pagination offset
 * @returns {Promise<{ rows: object[], total: number }>}
 */
async function listScheduledMessages({
  batchId,
  status,
  phone,
  limit = 200,
  offset = 0,
  timeoutMs,
} = {}) {
  return callSamvaadik(
    async (client) => {
      const params = { limit, offset };
      if (batchId) params.batch_id = batchId;
      if (status) params.status = status;
      if (phone) params.phone = phone;

      const res = await client.get("/messages/schedule", { params });
      // Response: { success, total, limit, offset, data: [...rows] }
      return {
        rows: res.data?.data || [],
        total: res.data?.total || 0,
      };
    },
    { timeoutMs },
  );
}

module.exports = {
  sendText,
  sendTemplate,
  sendInteractive,
  downloadMedia,
  parseWebhook,
  createTemplate,
  listTemplates,
  getTemplate,
  deleteTemplate,
  uploadMediaFromUrl,
  getTemplateStatus,
  scheduleTemplateMessage,
  listScheduledMessages,
  getProduct,
  updateInventory,
  getOrderStatus,
};
