// src/routes/supplierPortalRoutes.js
const { Router } = require("express");
const { resolveSupplierByToken } = require("../middleware/supplierPortalAuth");
const { getPortalItems, confirmAll, confirmItem } = require("../controllers/supplierPortalController");

const router = Router();

// Public — Supplier.portalToken itself is the auth, see supplierPortalAuth.js.
router.get("/:token/items", resolveSupplierByToken, getPortalItems);
router.post("/:token/confirm-all", resolveSupplierByToken, confirmAll);
router.post("/:token/confirm-item", resolveSupplierByToken, confirmItem);

module.exports = router;
