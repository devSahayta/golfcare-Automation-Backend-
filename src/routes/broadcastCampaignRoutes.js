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
  recomposeCampaignImageText,
  resolveProductImage,
  scheduleCampaign,
} = require("../controllers/broadcastCampaignController");

const { prisma } = require("../lib/prisma");

const router = Router();

// All campaign endpoints require a logged-in staff member
router.use(requireStaffAuth);

// GET  /api/campaigns           — list all campaigns (paginated)
router.get("/", listCampaigns);

router.post("/draft", createCampaignDraft);

router.post("/preview-image", previewCampaignImage);

// Cheap wording-only edit: re-draws eyebrow/headline/badge text over an
// already-generated backdrop, no new Flux call.
router.post("/preview-image/text", recomposeCampaignImageText);

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

module.exports = router;
