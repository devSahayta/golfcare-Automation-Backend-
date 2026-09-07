// config/env.js
require("dotenv").config();

const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.API_PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || "",
  kindeDomain: process.env.KINDE_DOMAIN || "",
  samvaadik: {
    baseUrl: process.env.SAMVAADIK_API_BASE_URL || "",
    apiKey: process.env.SAMVAADIK_API_KEY || "",
    webhookSecret: process.env.SAMVAADIK_WEBHOOK_SECRET || "",
  },
  shopify: {
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN || "",
    clientId: process.env.SHOPIFY_CLIENT_ID || "",
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET || "",
    webhookBaseUrl: process.env.SHOPIFY_WEBHOOK_BASE_URL || "",
    // Optional: skips the locations.json lookup if the store has more than
    // one location and Golf Care doesn't want the first one picked for it.
    locationId: process.env.SHOPIFY_LOCATION_ID || "",
    // Placeholder policy — see services/shopifyInventory.js header. Pending
    // Tejas's decision on out-of-stock storefront behaviour (plan §11.1).
    defaultAvailableQty: Number(
      process.env.SHOPIFY_DEFAULT_AVAILABLE_QTY || 99,
    ),
  },
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  approvalLinkBaseUrl:
    process.env.APPROVAL_LINK_BASE_URL || "http://localhost:4000",
  // Placeholder default — TTL per product category is still an open
  // decision (plan §11.5). 168h = 7 days.
  availabilityTtlHours: Number(process.env.AVAILABILITY_TTL_HOURS || 168),

  anthropicModel: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
  discountCeilingPercent: Number(process.env.DISCOUNT_CEILING_PERCENT || 0),
  handoverValueThresholdInr: Number(
    process.env.HANDOVER_VALUE_THRESHOLD_INR || 75000,
  ),
  agentMaxToolIterations: Number(process.env.AGENT_MAX_TOOL_ITERATIONS || 6),
  agentHistoryMessageLimit: Number(
    process.env.AGENT_HISTORY_MESSAGE_LIMIT || 20,
  ),
  agentProcessingLockStaleMinutes: Number(
    process.env.AGENT_PROCESSING_LOCK_STALE_MINUTES || 5,
  ),
  // Cap on extracted text from a supplier-sent PDF/sheet attachment before
  // it becomes a Message.body — keeps a large upload from blowing out the
  // conversation's context window on every subsequent turn.
  documentExtractMaxChars: Number(
    process.env.DOCUMENT_EXTRACT_MAX_CHARS || 20000,
  ),
  email: {
    providerApiKey: process.env.EMAIL_PROVIDER_API_KEY || "",
    fromAddress: process.env.EMAIL_FROM_ADDRESS || "",
  },
  // Module 5.2 — who gets ProductDraft approval emails. StaffUser has no
  // notification-preference field and ProductDraft.emailSentTo is a
  // single string, not a list, so this is one configured address rather
  // than fan-out to multiple staff.
  staffApprovalEmail: process.env.STAFF_APPROVAL_EMAIL || "",
  // Placeholder default, same pattern as every other TTL-style value here
  // — how long a ProductDraft's approval link stays valid before the
  // scheduler's expiry sweep flips it to EXPIRED.
  productDraftTokenExpiryDays: Number(
    process.env.PRODUCT_DRAFT_TOKEN_EXPIRY_DAYS || 7,
  ),
};

module.exports = { env };
