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
  // Hard backend cap (not just a prompt suggestion — confirmed live that
  // instruction alone doesn't reliably stop the model) on how many pending
  // check-in items list_pending_items will ever return in one call. Above
  // this, a supplier's catalog is too large to read out in a WhatsApp
  // message anyway; the agent is told to ask for a stock sheet or a
  // blanket status instead of enumerating.
  supplierListableItemLimit: Number(
    process.env.SUPPLIER_LISTABLE_ITEM_LIMIT || 40,
  ),
  // confirm_all_pending_items (supplierAgentTools.js) always updates every
  // item's DB record (the real source of truth), but each Shopify
  // inventory write is itself 2-3 Admin API calls — doing that inline for
  // thousands of items in one webhook request risks a serverless timeout
  // and hammers Shopify's rate limit. Only the first N (by this cap) get
  // an inline Shopify sync per bulk-confirm call; the rest are logged to
  // AuditLog as deferred rather than silently dropped. Raise this only
  // alongside the route's serverless maxDuration.
  bulkConfirmShopifySyncCap: Number(
    process.env.BULK_CONFIRM_SHOPIFY_SYNC_CAP || 100,
  ),
  // reconcile_stock_list's unmatched rows are the "maybe a new product"
  // path — each one the model tries to actively onboard costs a real
  // Shopify product-creation call, an approval email, and potentially a
  // web_search/web_fetch round trip. A sheet with dozens of genuinely new
  // (unmatched) rows would try to onboard all of them one by one in the
  // same turn — expensive, slow, and floods the approval inbox with one
  // email per product. Above this count, unmatched rows are capped and
  // the model is told to escalate the whole batch to a human instead of
  // attempting each one individually.
  supplierBulkNewProductLimit: Number(
    process.env.SUPPLIER_BULK_NEW_PRODUCT_LIMIT || 5,
  ),
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
