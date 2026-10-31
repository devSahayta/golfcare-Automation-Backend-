// middleware/supplierPortalAuth.js
//
// Auth for the public supplier stock-check portal — the token itself is
// the auth (Supplier.portalToken), same posture as productDraftRoutes.js's
// :token routes: no StaffUser session, no password, just a long,
// unguessable value a supplier gets via their WhatsApp check-in message.
const { prisma } = require("../lib/prisma");

async function resolveSupplierByToken(req, res, next) {
  const { token } = req.params;

  const supplier = await prisma.supplier.findUnique({ where: { portalToken: token } });
  if (!supplier || !supplier.isActive) {
    return res.status(404).json({ error: "invalid_link" });
  }

  req.supplier = supplier;
  next();
}

module.exports = { resolveSupplierByToken };
