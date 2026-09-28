// src/routes/productRoutes.js

const { Router } = require("express");
// const { requireStaffAuth } = require("../middleware/kindeAuth");
const {
  listProducts,
  getProductById,
} = require("../controllers/productController");

const router = Router();

// GET /api/products?search=&status=&tierLevel=&limit=&offset=
router.get("/", listProducts);
router.get("/:id", getProductById);

module.exports = router;
