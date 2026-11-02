const { Router } = require("express");
const { showSubmission, approveSubmission, rejectSubmission } = require("../controllers/supplierImageApprovalController");

const router = Router();

// Public — approvalToken itself is the auth (single-use, expiring), same
// posture as productDraftRoutes.js.
router.get("/:token", showSubmission);
router.post("/:token/approve", approveSubmission);
router.post("/:token/reject", rejectSubmission);

module.exports = router;
