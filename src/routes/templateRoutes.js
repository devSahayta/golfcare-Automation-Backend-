// src/routes/templateRoutes.js

const { Router } = require("express");
// const { requireStaffAuth } = require("../middleware/kindeAuth");
const { getTemplates } = require("../controllers/templateController");

const router = Router();

// GET /api/templates — Meta-approved WhatsApp templates, via Samvaadik
router.get("/", getTemplates);

module.exports = router;
