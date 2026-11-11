// src/routes/pricingConfigRoutes.js
//
// Mount in app.js as:
//   app.use("/api/pricing-config", require("./routes/pricingConfigRoutes"));
//
// All three routes require staff auth — this screen can change member
// discount percentages and the preview endpoint shows cost/floor data,
// both more sensitive than the existing routes that have requireStaffAuth
// commented out (that's intentional elsewhere per your own call; it isn't
// replicated here).

const express = require("express");
const router = express.Router();
const { requireStaffAuth } = require("../middleware/kindeAuth");
const {
  listPricingConfig,
  updatePricingConfig,
  previewPricingConfig,
} = require("../controllers/pricingConfigController");

router.get("/", requireStaffAuth, listPricingConfig);
router.put("/", requireStaffAuth, updatePricingConfig);
router.post("/preview", requireStaffAuth, previewPricingConfig);

module.exports = router;
