// controllers/productController.js
//
// Module 8 — Products/Availability screen. This is the catalog-browse
// side; the existing availabilityController.js already covers the
// availability-first view (needs-recheck queue, manual override) — this
// is deliberately separate rather than overloading that one.

const { prisma } = require("../lib/prisma");

async function listProducts(req, res) {
  const { search, status, tierLevel, limit, offset } = req.query;

  try {
    const where = {};

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { vendor: { contains: search, mode: "insensitive" } },
        { productType: { contains: search, mode: "insensitive" } },
      ];
    }
    if (status) where.status = status;
    if (tierLevel) where.tierLevel = tierLevel;

    const take = Math.min(Number(limit) || 50, 200);
    const skip = Number(offset) || 0;

    const [items, total] = await Promise.all([
      prisma.product.findMany({
        where,
        take,
        skip,
        orderBy: { syncedAt: "desc" },
        select: {
          id: true,
          title: true,
          handle: true,
          vendor: true,
          productType: true,
          priceMin: true,
          priceMax: true,
          status: true,
          tierLevel: true,
          imageUrls: true,
          _count: { select: { Variant: true } },
        },
      }),
      prisma.product.count({ where }),
    ]);

    res.json({ items, total, limit: take, offset: skip });
  } catch (err) {
    console.error("listProducts error:", err);
    res.status(500).json({ error: "Failed to list products" });
  }
}

async function getProductById(req, res) {
  const { id } = req.params;

  try {
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        Variant: {
          include: { AvailabilityState: true },
        },
      },
    });

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }

    res.json({ product });
  } catch (err) {
    console.error("getProductById error:", err);
    res.status(500).json({ error: "Failed to fetch product" });
  }
}

module.exports = { listProducts, getProductById };
