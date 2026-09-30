// controllers/auditLogController.js
const { prisma } = require("../lib/prisma");

async function listAuditLogs(req, res) {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const {
      actorType,
      action,
      entityType,
      entityId,
      source,
      search,
      from,
      to,
    } = req.query;

    const where = {};
    if (actorType) where.actorType = actorType;
    if (action) where.action = action;
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    if (source) where.source = source;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to);
    }
    if (search && !action)
      where.action = { contains: search, mode: "insensitive" };

    const [total, logs] = await Promise.all([
      prisma.auditLog.count({ where }),
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    res.json({
      data: logs,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("listAuditLogs error:", err);
    res.status(500).json({ error: "Failed to fetch audit logs" });
  }
}

// Distinct values that populate the frontend filter dropdowns
async function auditLogMeta(_req, res) {
  try {
    const [actions, entityTypes, sources, actorTypes] = await Promise.all([
      prisma.auditLog.findMany({
        distinct: ["action"],
        select: { action: true },
        orderBy: { action: "asc" },
      }),
      prisma.auditLog.findMany({
        distinct: ["entityType"],
        select: { entityType: true },
      }),
      prisma.auditLog.findMany({
        distinct: ["source"],
        select: { source: true },
      }),
      prisma.auditLog.findMany({
        distinct: ["actorType"],
        select: { actorType: true },
      }),
    ]);
    res.json({
      actions: actions.map((x) => x.action),
      entityTypes: entityTypes.map((x) => x.entityType),
      sources: sources.map((x) => x.source).filter(Boolean),
      actorTypes: actorTypes.map((x) => x.actorType),
    });
  } catch (err) {
    console.error("auditLogMeta error:", err);
    res.status(500).json({ error: "Failed to fetch audit meta" });
  }
}

module.exports = { listAuditLogs, auditLogMeta };
