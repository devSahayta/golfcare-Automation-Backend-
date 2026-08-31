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

async function deleteTemplate(_templateId) {
  throw new Error(
    "deleteTemplate is blocked: Samvaadik's public API has no DELETE /v1/templates/:id endpoint.",
  );
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

module.exports = {
  sendText,
  sendTemplate,
  sendInteractive,
  downloadMedia,
  parseWebhook,
  createTemplate,
  listTemplates,
  deleteTemplate,
  getProduct,
  updateInventory,
  getOrderStatus,
};
