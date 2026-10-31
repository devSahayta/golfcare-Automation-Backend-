// scripts/createMembershipTemplateV2.js
//
// Refined version of the membership-invite template: polished copy + two
// QUICK_REPLY buttons ("Tell me more" / "Not right now"), so the customer
// can tap instead of typing a free-text reply.
//
// Submitted as a NEW template name rather than editing/deleting the
// original (golfcare_membership_invite) — avoids any window where neither
// version is approved, and leaves a safe rollback if this one has issues.
//
// The buttons option/shape mirrors what broadcastCampaignController.js and
// the insights agent already use for QUICK_REPLY buttons on templates —
// same createTemplate() helper, same Samvaadik API, nothing new here.
//
// On the inbound side, no code changes are needed: when the customer taps
// a button, Samvaadik forwards its label text as a normal inbound message
// (src/webhooks/samvaadik.js just reads evt.message/evt.messageType
// generically), so it reaches the sales agent exactly like a typed reply
// and campaignReplyNote in salesAgentConfig.js already handles it.
//
// Run locally, from the golfcare-backend repo root, where your real .env
// (with SAMVAADIK_API_KEY etc.) is already set up:
//
//   node scripts/createMembershipTemplateV2.js
//
// This only SUBMITS the template to Meta for approval — it does NOT
// instantly make it usable. Once it shows APPROVED (Samvaadik's dashboard,
// or getTemplateStatus(wt_id) once you have the id), set
// MEMBERSHIP_INVITE_TEMPLATE_NAME on Vercel to the name below.

require("dotenv").config();
const { createTemplate } = require("../src/lib/samvaadik/adapter");

// WhatsApp template names: lowercase + underscores only, no spaces.
const TEMPLATE_NAME = "golfcare_membership_invite_v2";
const CATEGORY = "MARKETING";

// {{1}} = customer first name — matches maybeSendMembershipInvite()'s
// sendTemplate(customer.waPhone, templateName, [firstName]) call.
// Must stay byte-identical to membershipInviteService.js's messageBody
// (minus the {{1}} vs actual name substitution) so the stored Message.body
// record matches what the customer actually received.
const BODY_TEXT =
  "Hi {{1}}, thanks for your order with Golf Care! 🏌️ Quick one — we've got a free membership program with special pricing, early access to new stock, and a golf expert on WhatsApp whenever you need one. Want to hear more?";

// Meta requires a realistic example value for every {{n}} when submitting
// a template for approval.
const BODY_EXAMPLES = ["Thivagar"];

// Max 3 QUICK_REPLY buttons per Meta's own limit (see sendInteractive's
// check in this same adapter.js) — using 2 here.
const BUTTONS = [
  { type: "QUICK_REPLY", text: "Tell me more" },
  { type: "QUICK_REPLY", text: "Not right now" },
];

async function main() {
  console.log(`Submitting template "${TEMPLATE_NAME}" to Samvaadik/Meta...`);

  const result = await createTemplate(TEMPLATE_NAME, CATEGORY, BODY_TEXT, {
    bodyExamples: BODY_EXAMPLES,
    buttons: BUTTONS,
  });

  console.log("\nSubmitted. Samvaadik response:");
  console.log(JSON.stringify(result, null, 2));

  const wtId = result?.wt_id || result?.id;
  console.log(
    `\nNext steps:\n` +
      `  1. Wait for Meta's approval — check Samvaadik's own dashboard for "${TEMPLATE_NAME}"` +
      (wtId ? ` (wt_id: ${wtId}),` : ",") +
      ` or re-run getTemplateStatus("${wtId || "<wt_id above>"}") from a Node REPL until it reports APPROVED\n` +
      `     (note: getTemplateStatus only lists templates that are ALREADY approved — "not found yet" means still pending, not rejected).\n` +
      `  2. Once APPROVED, set MEMBERSHIP_INVITE_TEMPLATE_NAME=${TEMPLATE_NAME} in Vercel's env vars (not just local .env).\n` +
      `  3. Redeploy, then run the end-to-end test.\n`,
  );
}

main().catch((err) => {
  console.error("\nTemplate creation failed:");
  console.error(err.response?.data || err.message);
  process.exit(1);
});
