const { Router } = require("express");
const { requireStaffAuth } = require("../middleware/kindeAuth");
const {
  listAvailability,
  getAvailabilityByVariant,
  overrideAvailability,
} = require("../controllers/availabilityController");

const router = Router();

// GET /api/availability?status=UNKNOWN — needs-recheck queue view
router.get("/", requireStaffAuth, listAvailability);
router.get("/:variantId", requireStaffAuth, getAvailabilityByVariant);
// POST /api/availability/:variantId/override — manual staff override
router.post("/:variantId/override", requireStaffAuth, overrideAvailability);

module.exports = router;
