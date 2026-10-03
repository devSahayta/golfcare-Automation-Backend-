// routes/agentUsageRoutes.js
const { Router } = require("express");
const { requireStaffAuth } = require("../middleware/kindeAuth");
const {
  getAgentUsage,
  getAgentUsageSummary,
} = require("../controllers/agentUsageController");

const router = Router();

// GET /api/agent-usage/summary?from=&to=
router.get("/summary", requireStaffAuth, getAgentUsageSummary);

// GET /api/agent-usage/:agent  — agent is "sales" | "supplier" | "insights"
router.get("/:agent", requireStaffAuth, getAgentUsage);

module.exports = router;
