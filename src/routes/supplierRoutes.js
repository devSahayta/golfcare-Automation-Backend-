// src/routes/supplierRoutes.js

const { Router } = require("express");
// const { requireStaffAuth } = require("../middleware/kindeAuth");
const {
  listSuppliers,
  getSupplierById,
} = require("../controllers/supplierController");

const router = Router();

// GET /api/suppliers?search=&isActive=&limit=&offset=
router.get("/", listSuppliers);
router.get("/:id", getSupplierById);

module.exports = router;
