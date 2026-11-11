// src/routes/escalationRoutes.js
//
// Mount in app.js as:
//   app.use("/api/escalations", require("./routes/escalationRoutes"));

const express = require("express");
const router = express.Router();
const { requireStaffAuth } = require("../middleware/kindeAuth");
const { listEscalations } = require("../controllers/escalationController");

router.get("/", requireStaffAuth, listEscalations);

module.exports = router;
