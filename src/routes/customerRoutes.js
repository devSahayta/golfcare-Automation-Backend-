// src/routes/customerRoutes.js

const { Router } = require("express");
const { requireStaffAuth } = require("../middleware/kindeAuth");
const {
  listCustomers,
  getCustomerById,
} = require("../controllers/customerController");

const router = Router();

// GET /api/customers?search=&tier=&isMember=&limit=&offset=
router.get("/", listCustomers);
router.get("/:id", getCustomerById);

module.exports = router;
