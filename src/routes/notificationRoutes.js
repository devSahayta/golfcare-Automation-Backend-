const { Router } = require("express");
// const { requireStaffAuth } = require("../middleware/kindeAuth");
const { listNotifications } = require("../controllers/notificationController");

const router = Router();

// GET /api/notifications — recent inbound message activity (Dashboard feed)
router.get("/", listNotifications);

module.exports = router;
