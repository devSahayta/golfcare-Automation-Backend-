const { Router } = require("express");
const { requireStaffAuth } = require("../middleware/kindeAuth");
const { askInsights } = require("../controllers/insightsController");

const router = Router();

// POST /api/insights/ask — { message, history? }
router.post("/ask", requireStaffAuth, askInsights);

module.exports = router;
