const { Router } = require("express");
const { showTemplate, approveTemplate, rejectTemplate } = require("../controllers/dynamicTemplateController");

const router = Router();

// Public — approvalToken itself is the auth (single-use, expiring).
router.get("/:token", showTemplate);
router.post("/:token/approve", approveTemplate);
router.post("/:token/reject", rejectTemplate);

module.exports = router;
