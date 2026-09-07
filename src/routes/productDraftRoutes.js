const { Router } = require("express");
const { showDraft, approveDraft, rejectDraft } = require("../controllers/productDraftController");

const router = Router();

// Public — approvalToken itself is the auth (single-use, expiring).
router.get("/:token", showDraft);
router.post("/:token/approve", approveDraft);
router.post("/:token/reject", rejectDraft);

module.exports = router;
