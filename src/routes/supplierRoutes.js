// src/routes/supplierRoutes.js

const { Router } = require("express");
const { requireStaffAuth } = require("../middleware/kindeAuth");
const {
  listSuppliers,
  getSupplierById,
  listCatalogBrands,
  createSupplier,
  updateSupplier,
  deactivateSupplier,
  deleteSupplierPermanently,
  regenerateSupplierPortalToken,
} = require("../controllers/supplierController");

const router = Router();

// GET /api/suppliers?search=&isActive=&limit=&offset=
router.get("/", listSuppliers);
// Must be registered before GET /:id, or Express matches "catalog-brands"
// as an :id instead.
router.get("/catalog-brands", requireStaffAuth, listCatalogBrands);
router.post("/", requireStaffAuth, createSupplier);
router.get("/:id", getSupplierById);
router.patch("/:id", requireStaffAuth, updateSupplier);
router.delete("/:id", requireStaffAuth, deactivateSupplier);
router.delete("/:id/permanent", requireStaffAuth, deleteSupplierPermanently);
router.post("/:id/portal-token/regenerate", requireStaffAuth, regenerateSupplierPortalToken);

module.exports = router;
