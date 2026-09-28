// controllers/supplierController.js
//
// Module 8 — Suppliers screen. Read-only for the Dashboard; the actual
// write logic (confirming stock, matching products) already lives in
// supplierAgent's tools and runs over WhatsApp, not through this API.

const { prisma } = require("../lib/prisma");

async function listSuppliers(req, res) {
  const { search, isActive, limit, offset } = req.query;

  try {
    const where = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { contactName: { contains: search, mode: "insensitive" } },
        { waPhone: { contains: search } },
      ];
    }
    if (isActive !== undefined) where.isActive = isActive === "true";

    const take = Math.min(Number(limit) || 50, 200);
    const skip = Number(offset) || 0;

    const [items, total] = await Promise.all([
      prisma.supplier.findMany({
        where,
        take,
        skip,
        orderBy: { reliabilityScore: "desc" },
        select: {
          id: true,
          name: true,
          contactName: true,
          waPhone: true,
          email: true,
          brands: true,
          categories: true,
          checkCadence: true,
          isActive: true,
          reliabilityScore: true,
          avgResponseMins: true,
          _count: { select: { SupplierProduct: true } },
        },
      }),
      prisma.supplier.count({ where }),
    ]);

    res.json({ items, total, limit: take, offset: skip });
  } catch (err) {
    console.error("listSuppliers error:", err);
    res.status(500).json({ error: "Failed to list suppliers" });
  }
}

async function getSupplierById(req, res) {
  const { id } = req.params;

  try {
    const supplier = await prisma.supplier.findUnique({
      where: { id },
      include: {
        SupplierProduct: {
          include: { Product: true, Variant: true },
        },
        SupplierCheck: {
          orderBy: { sentAt: "desc" },
          take: 20,
        },
      },
    });

    if (!supplier) {
      return res.status(404).json({ error: "Supplier not found" });
    }

    res.json({ supplier });
  } catch (err) {
    console.error("getSupplierById error:", err);
    res.status(500).json({ error: "Failed to fetch supplier" });
  }
}

module.exports = { listSuppliers, getSupplierById };
