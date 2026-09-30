// routes/auditLogRoutes.js
const express = require("express");
const {
  listAuditLogs,
  auditLogMeta,
} = require("../controllers/auditLogController");

const router = express.Router();
router.get("/meta", auditLogMeta); // keep before any /:id route
router.get("/", listAuditLogs);

module.exports = router;
