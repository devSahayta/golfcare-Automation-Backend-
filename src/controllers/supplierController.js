// controllers/supplierController.js
//
// Module 8 — Suppliers screen. Originally read-only; create/update/
// deactivate added so staff can onboard real suppliers and manage their
// brand assignments from the dashboard instead of hand-editing the DB.

const { prisma } = require("../lib/prisma");
const { backfillSupplierProductsByBrand } = require("../services/supplierProductBackfill");
const { validateBrandAssignment, cleanupUnlinkedBrandProducts } = require("../services/supplierBrandRules");

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

// GET /api/suppliers/catalog-brands — every distinct real Product.vendor
// value, flagged with its current owner (if any). Backs the dashboard's
// brand picker: pick-from-catalog, not free text, so there's no case
// mismatch against backfillSupplierProductsByBrand's exact-string match.
async function listCatalogBrands(req, res) {
  try {
    const [vendors, suppliers] = await Promise.all([
      prisma.product.findMany({ select: { vendor: true }, distinct: ["vendor"] }),
      prisma.supplier.findMany({ where: { isActive: true }, select: { id: true, name: true, brands: true } }),
    ]);

    const ownerByBrand = new Map();
    for (const s of suppliers) {
      for (const b of s.brands) ownerByBrand.set(b, { ownerSupplierId: s.id, ownerSupplierName: s.name });
    }

    const brands = vendors
      .map((v) => v.vendor)
      .filter(Boolean)
      .sort()
      .map((brand) => ({ brand, owner: ownerByBrand.get(brand) || null }));

    res.json({ brands });
  } catch (err) {
    console.error("listCatalogBrands error:", err);
    res.status(500).json({ error: "Failed to load catalog brands" });
  }
}

function cleanBrandsInput(brands) {
  return Array.isArray(brands) ? [...new Set(brands.filter(Boolean))] : [];
}

// POST /api/suppliers
async function createSupplier(req, res) {
  const { name, contactName, waPhone, email, brands, checkCadence, checkDayOfWeek, checkHour, isActive } = req.body;

  if (!name || !waPhone || !checkCadence) {
    return res.status(400).json({ error: "name, waPhone, and checkCadence are required" });
  }

  const cleanBrands = cleanBrandsInput(brands);

  try {
    if (cleanBrands.length > 0) {
      const conflicts = await validateBrandAssignment({ brands: cleanBrands });
      if (conflicts.length > 0) {
        return res.status(409).json({ error: "brand_conflict", conflicts });
      }
    }

    const supplier = await prisma.supplier.create({
      data: {
        name,
        contactName: contactName || null,
        waPhone,
        email: email || null,
        brands: cleanBrands,
        checkCadence,
        checkDayOfWeek: checkDayOfWeek ?? null,
        checkHour: checkHour ?? 10,
        isActive: isActive ?? true,
      },
    });

    let backfillSummary = null;
    if (cleanBrands.length > 0) {
      const [summary] = await backfillSupplierProductsByBrand({ supplierId: supplier.id });
      backfillSummary = summary || null;
    }

    await prisma.auditLog.create({
      data: {
        actorType: "STAFF",
        actorId: req.staffUser.id,
        action: "SUPPLIER_CREATED",
        entityType: "Supplier",
        entityId: supplier.id,
        afterState: { name, waPhone, brands: cleanBrands },
        source: "suppliers_dashboard",
      },
    });

    res.status(201).json({ supplier, backfillSummary });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A supplier with this phone number already exists." });
    }
    console.error("createSupplier error:", err);
    res.status(500).json({ error: "Failed to create supplier" });
  }
}

// PATCH /api/suppliers/:id
async function updateSupplier(req, res) {
  const { id } = req.params;
  const { name, contactName, waPhone, email, brands, checkCadence, checkDayOfWeek, checkHour, isActive } = req.body;

  try {
    const existing = await prisma.supplier.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Supplier not found" });

    const data = {};
    if (name !== undefined) data.name = name;
    if (contactName !== undefined) data.contactName = contactName || null;
    if (waPhone !== undefined) data.waPhone = waPhone;
    if (email !== undefined) data.email = email || null;
    if (checkCadence !== undefined) data.checkCadence = checkCadence;
    if (checkDayOfWeek !== undefined) data.checkDayOfWeek = checkDayOfWeek;
    if (checkHour !== undefined) data.checkHour = checkHour;
    if (isActive !== undefined) data.isActive = isActive;

    let addedBrands = [];
    let removedBrands = [];
    if (brands !== undefined) {
      const cleanBrands = cleanBrandsInput(brands);
      addedBrands = cleanBrands.filter((b) => !existing.brands.includes(b));
      removedBrands = existing.brands.filter((b) => !cleanBrands.includes(b));

      if (addedBrands.length > 0) {
        const conflicts = await validateBrandAssignment({ brands: addedBrands, excludeSupplierId: id });
        if (conflicts.length > 0) {
          return res.status(409).json({ error: "brand_conflict", conflicts });
        }
      }
      data.brands = cleanBrands;
    }

    const supplier = await prisma.supplier.update({ where: { id }, data });

    let backfillSummary = null;
    if (addedBrands.length > 0) {
      const [summary] = await backfillSupplierProductsByBrand({ supplierId: id });
      backfillSummary = summary || null;
    }

    let cleanupSummary = null;
    if (removedBrands.length > 0) {
      cleanupSummary = await cleanupUnlinkedBrandProducts({ supplierId: id, removedBrands });
    }

    await prisma.auditLog.create({
      data: {
        actorType: "STAFF",
        actorId: req.staffUser.id,
        action: "SUPPLIER_UPDATED",
        entityType: "Supplier",
        entityId: id,
        beforeState: { brands: existing.brands, isActive: existing.isActive },
        afterState: { brands: supplier.brands, isActive: supplier.isActive },
        source: "suppliers_dashboard",
      },
    });

    res.json({ supplier, backfillSummary, cleanupSummary });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A supplier with this phone number already exists." });
    }
    console.error("updateSupplier error:", err);
    res.status(500).json({ error: "Failed to update supplier" });
  }
}

// DELETE /api/suppliers/:id — never a real delete (see supplierBrandRules.js
// header / this feature's plan: a hard delete would be blocked by
// ProductImportBatch's restrict FK for any supplier with import history,
// and would cascade-wipe their whole SupplierProduct history otherwise).
// "Delete" means deactivate + clear brands, freeing them for reassignment.
async function deactivateSupplier(req, res) {
  const { id } = req.params;

  try {
    const existing = await prisma.supplier.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Supplier not found" });
    if (!existing.isActive) return res.status(400).json({ error: "Supplier is already inactive" });

    let cleanupSummary = null;
    if (existing.brands.length > 0) {
      cleanupSummary = await cleanupUnlinkedBrandProducts({ supplierId: id, removedBrands: existing.brands });
    }

    const supplier = await prisma.supplier.update({
      where: { id },
      data: { isActive: false, brands: [] },
    });

    await prisma.auditLog.create({
      data: {
        actorType: "STAFF",
        actorId: req.staffUser.id,
        action: "SUPPLIER_DEACTIVATED",
        entityType: "Supplier",
        entityId: id,
        beforeState: { brands: existing.brands, isActive: true },
        afterState: { brands: [], isActive: false },
        source: "suppliers_dashboard",
      },
    });

    res.json({ supplier, cleanupSummary });
  } catch (err) {
    console.error("deactivateSupplier error:", err);
    res.status(500).json({ error: "Failed to deactivate supplier" });
  }
}

// DELETE /api/suppliers/:id/permanent — an actual hard delete, separate
// from the soft "deactivate" above. Always blocked if the supplier has
// ProductImportBatch history (that FK is a DB-level restrict — Prisma
// would throw anyway, this just gives a clear message). Otherwise, if the
// supplier still has SupplierProduct/SupplierCheck rows, requires
// ?force=true to confirm — a plain delete would cascade and silently wipe
// them, confirmed pricing included.
async function deleteSupplierPermanently(req, res) {
  const { id } = req.params;
  const force = req.query.force === "true" || req.body?.force === true;

  try {
    const existing = await prisma.supplier.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Supplier not found" });

    const batchCount = await prisma.productImportBatch.count({ where: { supplierId: id } });
    if (batchCount > 0) {
      return res.status(409).json({
        error: "has_import_history",
        message: `${existing.name} has ${batchCount} import batch(es) on record and can't be permanently deleted. Deactivate instead.`,
      });
    }

    const [productCount, confirmedCount, checkCount] = await Promise.all([
      prisma.supplierProduct.count({ where: { supplierId: id } }),
      prisma.supplierProduct.count({ where: { supplierId: id, lastConfirmedAt: { not: null } } }),
      prisma.supplierCheck.count({ where: { supplierId: id } }),
    ]);

    if ((productCount > 0 || checkCount > 0) && !force) {
      return res.status(409).json({
        error: "has_linked_products",
        message: `This will permanently remove ${productCount} linked product${productCount === 1 ? "" : "s"} (${confirmedCount} with confirmed pricing) and ${checkCount} check record${checkCount === 1 ? "" : "s"}. This cannot be undone.`,
        productCount,
        confirmedCount,
        checkCount,
      });
    }

    await prisma.auditLog.create({
      data: {
        actorType: "STAFF",
        actorId: req.staffUser.id,
        action: "SUPPLIER_DELETED",
        entityType: "Supplier",
        entityId: id,
        beforeState: {
          name: existing.name,
          brands: existing.brands,
          isActive: existing.isActive,
          productCount,
          confirmedCount,
          checkCount,
        },
        source: "suppliers_dashboard",
      },
    });

    await prisma.supplier.delete({ where: { id } });

    res.json({ deleted: true, removedLinkedProducts: productCount, removedChecks: checkCount });
  } catch (err) {
    console.error("deleteSupplierPermanently error:", err);
    res.status(500).json({ error: "Failed to delete supplier" });
  }
}

module.exports = {
  listSuppliers,
  getSupplierById,
  listCatalogBrands,
  createSupplier,
  updateSupplier,
  deactivateSupplier,
  deleteSupplierPermanently,
};
