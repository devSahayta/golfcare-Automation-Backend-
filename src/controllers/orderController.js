// controllers/orderController.js
const { prisma } = require("../lib/prisma");

function parsePaging(q) {
  const page = Math.max(parseInt(q.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(q.limit) || 20, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

async function listOrders(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req.query);
    const { search, financialStatus, fulfillmentStatus, from, to } = req.query;

    const where = {};
    if (financialStatus) where.financialStatus = financialStatus;
    if (fulfillmentStatus === "unfulfilled") where.fulfillmentStatus = null;
    else if (fulfillmentStatus) where.fulfillmentStatus = fulfillmentStatus;
    if (from || to) {
      where.placedAt = {};
      if (from) where.placedAt.gte = new Date(from);
      if (to) where.placedAt.lte = new Date(to);
    }
    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: "insensitive" } },
        { shopifyOrderId: { contains: search } },
        { Customer: { email: { contains: search, mode: "insensitive" } } },
        { Customer: { waPhone: { contains: search } } },
      ];
    }

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: { placedAt: "desc" },
        skip,
        take: limit,
        include: { Customer: true },
      }),
    ]);

    res.json({
      data: orders.map(({ Customer, ...o }) => ({
        ...o,
        customer: Customer,
        itemCount: Array.isArray(o.lineItems)
          ? o.lineItems.reduce((n, li) => n + (li.quantity || 1), 0)
          : 0,
        lineItems: undefined, // keep list payload small
      })),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("listOrders error:", err);
    res.status(500).json({ error: "Failed to fetch orders" });
  }
}

async function getOrder(req, res) {
  try {
    const found = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { Customer: true },
    });
    if (!found) return res.status(404).json({ error: "Order not found" });
    const { Customer, ...order } = found;

    const activity = await prisma.auditLog.findMany({
      where: { entityType: "Order", entityId: order.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    res.json({ ...order, customer: Customer, activity });
  } catch (err) {
    console.error("getOrder error:", err);
    res.status(500).json({ error: "Failed to fetch order" });
  }
}

module.exports = { listOrders, getOrder };
