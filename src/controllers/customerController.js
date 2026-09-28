// controllers/customerController.js
//
// Module 8 — Customers screen. Read-only for now; no write path needed
// yet (staff aren't editing customer records from the Dashboard).

const { prisma } = require("../lib/prisma");

async function listCustomers(req, res) {
  const { search, tier, isMember, limit, offset } = req.query;

  try {
    const where = {};

    if (search) {
      where.OR = [
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { waPhone: { contains: search } },
      ];
    }
    if (tier) where.tier = tier;
    if (isMember !== undefined) where.isMember = isMember === "true";

    const take = Math.min(Number(limit) || 50, 200);
    const skip = Number(offset) || 0;

    const [items, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        take,
        skip,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          waPhone: true,
          city: true,
          state: true,
          isMember: true,
          memberCode: true,
          tier: true,
          lifetimeValue: true,
          orderCount: true,
          lastOrderAt: true,
          createdAt: true,
        },
      }),
      prisma.customer.count({ where }),
    ]);

    res.json({ items, total, limit: take, offset: skip });
  } catch (err) {
    console.error("listCustomers error:", err);
    res.status(500).json({ error: "Failed to list customers" });
  }
}

async function getCustomerById(req, res) {
  const { id } = req.params;

  try {
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        GolferProfile: true,
        Order: {
          orderBy: { placedAt: "desc" },
          take: 20,
        },
      },
    });

    if (!customer) {
      return res.status(404).json({ error: "Customer not found" });
    }

    res.json({ customer });
  } catch (err) {
    console.error("getCustomerById error:", err);
    res.status(500).json({ error: "Failed to fetch customer" });
  }
}

module.exports = { listCustomers, getCustomerById };
