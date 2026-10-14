// routes/campaignRoutes.js
const { Router } = require("express");
const { requireStaffAuth } = require("../middleware/kindeAuth");
const {
  getCampaignSummary,
  listCampaignTriggers,
  listCampaignTemplates,
  getCampaignTemplate,
  approveCampaignTemplate,
  rejectCampaignTemplate,
  getStaticCampaignTemplate,
} = require("../controllers/campaignController");

const router = Router();

// GET /api/campaigns/summary
router.get("/summary", requireStaffAuth, getCampaignSummary);

// GET /api/campaigns/triggers?scenario=&status=&page=&limit=
router.get("/triggers", requireStaffAuth, listCampaignTriggers);

// GET /api/campaigns/templates?scenario=&approval=&page=&limit=
router.get("/templates", requireStaffAuth, listCampaignTemplates);

// GET /api/campaigns/templates/:id
router.get("/templates/:id", requireStaffAuth, getCampaignTemplate);

// GET /api/campaigns/static/:scenario  — BIRTHDAY | REPLENISHMENT
router.get("/static/:scenario", requireStaffAuth, getStaticCampaignTemplate);

// POST /api/campaigns/templates/:id/approve
router.post("/templates/:id/approve", requireStaffAuth, approveCampaignTemplate);

// POST /api/campaigns/templates/:id/reject
router.post("/templates/:id/reject", requireStaffAuth, rejectCampaignTemplate);

module.exports = router;
