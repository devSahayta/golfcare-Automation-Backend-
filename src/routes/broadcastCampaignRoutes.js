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
} = require("../controllers/broadcastCampaignController");

const router = Router();

// All campaign endpoints require a logged-in staff member
router.use(requireStaffAuth);

// GET  /api/campaigns           — list all campaigns (paginated)
router.get("/", listCampaigns);

router.post("/draft", createCampaignDraft);

router.post("/preview-image", previewCampaignImage);

router.patch("/:id/template", updateCampaignTemplate);

// GET  /api/campaigns/:id       — get one campaign + live status poll
router.get("/:id", getCampaign);

// POST /api/campaigns/:id/submit — submit template to Meta (DRAFT → SUBMITTED)
router.post("/:id/submit", submitCampaign);

// POST /api/campaigns/:id/send   — fan out scheduling (READY → SCHEDULED)
router.post("/:id/send", sendCampaign);

// POST /api/campaigns/:id/cancel — cancel at any non-terminal state
router.post("/:id/cancel", cancelCampaign);

module.exports = router;
