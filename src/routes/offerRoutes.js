// src/routes/offerRoutes.js
//
// Mount in app.js as:
//   app.use("/api/offers", require("./routes/offerRoutes"));

const express = require("express");
const router = express.Router();
const { requireStaffAuth } = require("../middleware/kindeAuth");
const { listOffers } = require("../controllers/offerController");

router.get("/", requireStaffAuth, listOffers);

module.exports = router;
