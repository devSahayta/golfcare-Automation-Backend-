// routes/productImportRoutes.js
const { Router } = require("express");
const { requireStaffAuth } = require("../middleware/kindeAuth");
const {
  listDrafts,
  getDraft,
  approveDraftById,
  rejectDraftById,
  listBatches,
  getBatch,
  getSummary,
} = require("../controllers/productImportController");

const router = Router();

// GET /api/product-imports/summary
router.get("/summary", requireStaffAuth, getSummary);

// GET /api/product-imports/drafts?status=&supplierId=&page=&limit=
router.get("/drafts", requireStaffAuth, listDrafts);

// GET /api/product-imports/drafts/:id
router.get("/drafts/:id", requireStaffAuth, getDraft);

// POST /api/product-imports/drafts/:id/approve
router.post("/drafts/:id/approve", requireStaffAuth, approveDraftById);

// POST /api/product-imports/drafts/:id/reject
router.post("/drafts/:id/reject", requireStaffAuth, rejectDraftById);

// GET /api/product-imports/batches?status=&supplierId=&page=&limit=
router.get("/batches", requireStaffAuth, listBatches);

// GET /api/product-imports/batches/:id
router.get("/batches/:id", requireStaffAuth, getBatch);

module.exports = router;
