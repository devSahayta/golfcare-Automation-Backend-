// src/routes/supplierPortalRoutes.js
const { Router } = require("express");
const multer = require("multer");
const { resolveSupplierByToken } = require("../middleware/supplierPortalAuth");
const {
  getPortalItems,
  confirmAll,
  confirmItem,
  uploadItemImage,
  getItemStock,
  createNewProductDraft,
} = require("../controllers/supplierPortalController");

const router = Router();

// Memory storage only — the buffer goes straight to Supabase Storage
// (uploadSupplierImage), nothing is ever written to local disk. 8MB cap and
// an image-only allowlist reject anything else before it reaches Supabase.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  },
});

// Public — Supplier.portalToken itself is the auth, see supplierPortalAuth.js.
router.get("/:token/items", resolveSupplierByToken, getPortalItems);
router.post("/:token/confirm-all", resolveSupplierByToken, confirmAll);
router.post("/:token/confirm-item", resolveSupplierByToken, confirmItem);
// This app has no global Express error handler, so a MulterError (e.g.
// file too big, or fileFilter rejecting the mimetype) would otherwise fall
// through to Express's default HTML error page instead of the clean JSON
// every other response on this router returns. Catch it locally.
function handleUpload(req, res, next) {
  upload.single("image")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      const message =
        err.code === "LIMIT_FILE_SIZE" ? "Image must be 8MB or smaller" : "Invalid upload";
      return res.status(400).json({ error: message });
    }
    if (err) return next(err);
    if (!req.file) {
      // fileFilter rejected it silently (wrong mimetype) — multer calls
      // cb(null, false) rather than erroring, so req.file is just absent.
      return res.status(400).json({ error: "Only JPEG, PNG, or WebP images are allowed" });
    }
    next();
  });
}

router.post("/:token/items/:supplierProductId/image", resolveSupplierByToken, handleUpload, uploadItemImage);
router.get("/:token/items/:supplierProductId/stock", resolveSupplierByToken, getItemStock);
router.post("/:token/products", resolveSupplierByToken, handleUpload, createNewProductDraft);

module.exports = router;
