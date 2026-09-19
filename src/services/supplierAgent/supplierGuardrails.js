// src/services/supplierAgent/supplierGuardrails.js
//
// agentEngine/guardrails.js is Sales-Agent-specific (its own header says
// so — "give each its own guardrail rule list rather than overloading
// this one"). This is the Supplier Agent's, wired in via
// supplierAgentConfig.runGuardrails.
//
// Deliberately minimal for the check-in flow (5.1): there's no price/
// stock claim being made TO a paying customer here, so the Sales-style
// "unverified claim" checks don't apply. The meaningful guardrail
// territory for this agent — never publish a scraped spec/price without
// human approval — belongs to the not-yet-built product-onboarding flow
// (module 5.2), not this one.

// Confirmed live: in one real conversation, the model told a supplier
// four different new products were "created and live" — checkmarks and
// all — across two separate replies, without ever once calling
// create_product_draft for any of them. supplierAgentConfig.js's system
// prompt now tells the model explicitly what's still outstanding (see
// pendingProductLeadsSection), but that alone isn't trusted to be
// enough — prompt-only instructions have already failed to hold up once
// this session (the confirm_availability id-reuse bug). This is the
// actual backend guarantee: if a reply sounds like it's claiming a new
// product is done, and no create_product_draft/escalate_to_human call
// actually happened (or the one that did errored out) in generating this
// exact reply, block it — the existing self-heal retry in
// agentEngine/index.js gives the model one honest chance to actually call
// the tool instead of just restating the same claim.
const COMPLETION_MARKERS =
  /\b(created|now live|is live|locked in|all set|added to (the )?catalog|has been added|now available|set up|synced)\b|✅/i;

function textMentionsLead(draftText, leadTitle) {
  const textLower = draftText.toLowerCase();
  const titleTokens = leadTitle
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  if (titleTokens.length === 0) return false;
  const matchedCount = titleTokens.filter((t) => textLower.includes(t)).length;
  return matchedCount / titleTokens.length >= 0.5;
}

function runGuardrails({ draftText, toolCallLog, context }) {
  if (!draftText) {
    return { action: "block", reason: "no_draft_text" };
  }

  const sessionExpiresAt = context.conversation.sessionExpiresAt;
  if (sessionExpiresAt && new Date(sessionExpiresAt) < new Date()) {
    return { action: "block", reason: "session_window_expired" };
  }

  const calls = toolCallLog || [];

  const pendingLeads = context.pendingProductLeads || [];
  if (pendingLeads.length > 0 && COMPLETION_MARKERS.test(draftText)) {
    const tookRealAction = calls.some((c) => {
      if (c.tool === "escalate_to_human") return true;
      if (c.tool === "create_product_draft") return !c.output?.error;
      return false;
    });
    if (!tookRealAction) {
      const claimedLead = pendingLeads.find((lead) => textMentionsLead(draftText, lead.title));
      if (claimedLead) {
        return {
          action: "block",
          reason: `claims "${claimedLead.title}" is done without a real create_product_draft or escalate_to_human call this turn`,
        };
      }
    }
  }

  // Confirmed live, same failure shape as the new-product one above: a
  // check-in item that came back "ambiguous" from reconcile_stock_list
  // (matched more than one catalog candidate, nothing actually applied)
  // got told to the supplier as "recorded"/"all set" anyway, after
  // several rounds of the supplier trying to pick one and the model
  // having no way to actually apply that pick. The underlying dead-end
  // (reconcile_stock_list had no way to select a specific candidate) is
  // now fixed, but this stays as a backend guarantee rather than trusting
  // the model to never claim an unresolved item is done.
  const unresolvedStockItems = calls
    .filter((c) => c.tool === "reconcile_stock_list")
    .flatMap((c) => (Array.isArray(c.output?.ambiguous) ? c.output.ambiguous : []))
    .map((a) => a.skuOrName)
    .filter(Boolean);
  if (unresolvedStockItems.length > 0 && COMPLETION_MARKERS.test(draftText)) {
    const claimedItem = unresolvedStockItems.find((name) => textMentionsLead(draftText, name));
    if (claimedItem) {
      return {
        action: "block",
        reason: `claims "${claimedItem}" is recorded/done, but it came back ambiguous (unresolved) from reconcile_stock_list this turn`,
      };
    }
  }

  return { action: "pass" };
}

module.exports = { runGuardrails };
