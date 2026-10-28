// src/routes/broadcastCampaignRoutes.js
const { Router } = require("express");
const { requireStaffAuth } = require("../middleware/kindeAuth");
const {
  listCampaigns,
  getCampaign,
  submitCampaign,
  sendCampaign,
  cancelCampaign,
  createCampaignDraft,
  updateCampaignTemplate,
  previewCampaignImage,
  resolveProductImage,
  scheduleCampaign,
  retryCampaign,
} = require("../controllers/broadcastCampaignController");

const { prisma } = require("../lib/prisma");

const router = Router();

// All campaign endpoints require a logged-in staff member
router.use(requireStaffAuth);

// GET  /api/campaigns           — list all campaigns (paginated)
router.get("/", listCampaigns);

router.post("/draft", createCampaignDraft);

router.post("/preview-image", previewCampaignImage);

// NOTE: the old /preview-image/text "cheap wording-only edit" endpoint was
// removed along with the paste-compositing image pipeline — there's no
// longer a separable AI backdrop to re-draw text onto (FLUX.2 Pro produces
// the whole image, including wording, in one generation). A wording change
// now means calling POST /preview-image again.

router.post("/resolve-product-image", resolveProductImage);

router.patch("/:id/template", updateCampaignTemplate);

// GET  /api/campaigns/:id       — get one campaign + live status poll
router.get("/:id", getCampaign);

// POST /api/campaigns/:id/submit — submit template to Meta (DRAFT → SUBMITTED)
router.post("/:id/submit", submitCampaign);

// POST /api/campaigns/:id/send   — fan out scheduling (READY → SCHEDULED)
router.post("/:id/send", sendCampaign);

router.post("/:id/schedule", scheduleCampaign);

// POST /api/campaigns/:id/cancel — cancel at any non-terminal state
router.post("/:id/cancel", cancelCampaign);

// POST /api/campaigns/:id/retry — staff clicks "Retry failed messages"
router.post("/:id/retry", retryCampaign);

module.exports = router;
