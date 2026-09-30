// routes/orderRoutes.js
const express = require("express");
const { listOrders, getOrder } = require("../controllers/orderController");

const router = express.Router();
router.get("/", listOrders);
router.get("/:id", getOrder);

module.exports = router;
