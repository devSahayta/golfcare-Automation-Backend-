// controllers/productImportController.js
//
// Staff dashboard endpoints for product onboarding: the pending
// ProductDraft approval queue (both the one-by-one create_product_draft
// flow and bulk catalog imports land in the same table) and the
// bulk-import batch progress/cost/timing view (ProductImportBatch/Item).
//
// Approve/reject go through the SAME services/productDraftService.js the
// emailed-link flow (controllers/productDraftController.js) uses, so the
// two paths can't drift apart — same split as Module 6's campaign
// approval (campaignController.js / campaignTemplateService.js /
// dynamicTemplateController.js).
//
// Deliberately a separate route mount (/api/product-imports) from the
// public token flow (/api/product-drafts/:token) rather than sharing a
// router — avoids any path-collision risk between a real approval token
// and a literal staff-route segment, and matches the same
// public-vs-dashboard route split Module 6 already established.

const { prisma } = require("../lib/prisma");
const { approveAndPublish, reject } = require("../services/productDraftService");

const BULK_AGENT_NAME = "SUPPLIER_BULK_IMPORT";

function parsePaging(query) {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit) || 25, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function normalizeDraft(d) {
  const p = d.rawPayload || {};
  return {
    id: d.id,
    title: p.title || null,
    price: p.price ?? null,
    brand: p.brand || null,
    sku: p.sku || null,
    category: p.category || null,
    specs: p.specs || null,
    imageUrl: p.imageUrl || null,
    variantOptionName: p.variantOptionName || null,
    variants: Array.isArray(p.variants) ? p.variants : null,
    sourceType: d.sourceType,
    sourceNotes: p.sourceNotes || null,
    marginPercent: p.marginPercent ?? null,
    gstPercent: p.gstPercent ?? null,
    costPrice: p.costPrice ?? null,
    approvalStatus: d.approvalStatus,
    approvedVia: d.approvedVia,
    decidedBy: d.decidedBy,
    decidedAt: d.decidedAt,
    shopifyDraftProductId: d.shopifyDraftProductId,
    createdAt: d.createdAt,
    supplier: d.Supplier ? { id: d.Supplier.id, name: d.Supplier.name } : null,
  };
}

const DRAFT_INCLUDE = { Supplier: { select: { id: true, name: true } } };

// GET /api/product-imports/drafts?status=&supplierId=&page=&limit=
async function listDrafts(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req.query);
    const where = {};
    if (req.query.status) where.approvalStatus = req.query.status;
    if (req.query.supplierId) where.supplierId = req.query.supplierId;

    const [rows, total] = await Promise.all([
      prisma.productDraft.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: DRAFT_INCLUDE,
      }),
      prisma.productDraft.count({ where }),
    ]);

    res.json({
      data: rows.map(normalizeDraft),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error("listDrafts error:", err.message);
    res.status(500).json({ error: "Failed to load product drafts" });
  }
}

// GET /api/product-imports/drafts/:id
async function getDraft(req, res) {
  try {
    const d = await prisma.productDraft.findUnique({ where: { id: req.params.id }, include: DRAFT_INCLUDE });
    if (!d) return res.status(404).json({ error: "Draft not found" });
    res.json({ data: normalizeDraft(d) });
  } catch (err) {
    console.error("getDraft error:", err.message);
    res.status(500).json({ error: "Failed to load draft" });
  }
}

function sendServiceError(res, err, fallbackMessage) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(fallbackMessage, err.message);
  return res.status(500).json({ error: fallbackMessage });
}

// POST /api/product-imports/drafts/:id/approve
async function approveDraftById(req, res) {
  try {
    await approveAndPublish(req.params.id, { approvedVia: "DASHBOARD", decidedBy: req.staffUser.email });
    const d = await prisma.productDraft.findUnique({ where: { id: req.params.id }, include: DRAFT_INCLUDE });
    res.json({ data: normalizeDraft(d) });
  } catch (err) {
    sendServiceError(res, err, "Failed to approve draft");
  }
}

// POST /api/product-imports/drafts/:id/reject
async function rejectDraftById(req, res) {
  try {
    await reject(req.params.id, { approvedVia: "DASHBOARD", decidedBy: req.staffUser.email });
    const d = await prisma.productDraft.findUnique({ where: { id: req.params.id }, include: DRAFT_INCLUDE });
    res.json({ data: normalizeDraft(d) });
  } catch (err) {
    sendServiceError(res, err, "Failed to reject draft");
  }
}

function normalizeBatch(b) {
  return {
    id: b.id,
    status: b.status,
    totalItems: b.totalItems,
    processedItems: b.processedItems,
    draftedCount: b.draftedCount,
    linkedCount: b.linkedCount,
    failedCount: b.failedCount,
    needsRateCount: b.needsRateCount,
    rateRules: b.rateRules,
    extractionError: b.extractionError,
    createdAt: b.createdAt,
    completedAt: b.completedAt,
    durationMs: b.completedAt ? new Date(b.completedAt) - new Date(b.createdAt) : null,
    supplier: b.Supplier ? { id: b.Supplier.id, name: b.Supplier.name } : null,
  };
}

// Real AI cost for a set of batches — AgentUsage rows tied to each
// batch's own id, agentName SUPPLIER_BULK_IMPORT (both the one-shot
// document-parsing call and the per-item research calls land there —
// see productImportDrain.js, scheduler repo). Keyed by productImportBatchId,
// NOT conversationId — conversationId is the supplier's one ongoing
// WhatsApp thread, shared across every batch they ever send, so grouping
// by it would sum ALL of a supplier's batches onto each one of their rows.
async function costByBatchIds(batchIds) {
  if (batchIds.length === 0) return {};
  const usage = await prisma.agentUsage.groupBy({
    by: ["productImportBatchId"],
    where: { productImportBatchId: { in: batchIds }, agentName: BULK_AGENT_NAME },
    _sum: { costUsd: true, costInr: true },
  });
  return Object.fromEntries(
    usage.map((u) => [
      u.productImportBatchId,
      { costUsd: Number(u._sum.costUsd || 0), costInr: Number(u._sum.costInr || 0) },
    ]),
  );
}

// GET /api/product-imports/batches?status=&supplierId=&page=&limit=
async function listBatches(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req.query);
    const where = {};
    if (req.query.status) where.status = req.query.status;
    if (req.query.supplierId) where.supplierId = req.query.supplierId;

    const [rows, total] = await Promise.all([
      prisma.productImportBatch.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { Supplier: { select: { id: true, name: true } } },
      }),
      prisma.productImportBatch.count({ where }),
    ]);

    const costByBatch = await costByBatchIds(rows.map((b) => b.id));
    const data = rows.map((b) => ({
      ...normalizeBatch(b),
      cost: costByBatch[b.id] || { costUsd: 0, costInr: 0 },
    }));

    res.json({ data, page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) });
  } catch (err) {
    console.error("listBatches error:", err.message);
    res.status(500).json({ error: "Failed to load import batches" });
  }
}

// GET /api/product-imports/batches/:id
async function getBatch(req, res) {
  try {
    const b = await prisma.productImportBatch.findUnique({
      where: { id: req.params.id },
      include: { Supplier: { select: { id: true, name: true } } },
    });
    if (!b) return res.status(404).json({ error: "Batch not found" });

    const items = await prisma.productImportItem.findMany({
      where: { batchId: b.id },
      orderBy: { createdAt: "asc" },
    });

    const usage = await prisma.agentUsage.aggregate({
      where: { productImportBatchId: b.id, agentName: BULK_AGENT_NAME },
      _sum: { costUsd: true, costInr: true, inputTokens: true, outputTokens: true },
      _count: { _all: true },
    });

    res.json({
      data: {
        ...normalizeBatch(b),
        cost: usage
          ? {
              costUsd: Number(usage._sum.costUsd || 0),
              costInr: Number(usage._sum.costInr || 0),
              inputTokens: usage._sum.inputTokens || 0,
              outputTokens: usage._sum.outputTokens || 0,
              calls: usage._count._all,
            }
          : { costUsd: 0, costInr: 0, inputTokens: 0, outputTokens: 0, calls: 0 },
        items: items.map((i) => ({
          id: i.id,
          title: i.title,
          sku: i.sku,
          brand: i.brand,
          category: i.category,
          mrp: i.mrp === null ? null : Number(i.mrp),
          marginPercent: i.marginPercent === null ? null : Number(i.marginPercent),
          gstPercent: i.gstPercent === null ? null : Number(i.gstPercent),
          variantOptionName: i.variantOptionName,
          variantCount: Array.isArray(i.variantOptions) ? i.variantOptions.length : 1,
          status: i.status,
          resultProductDraftId: i.resultProductDraftId,
          resultMatchedProductId: i.resultMatchedProductId,
          errorMessage: i.errorMessage,
          createdAt: i.createdAt,
          processedAt: i.processedAt,
        })),
      },
    });
  } catch (err) {
    console.error("getBatch error:", err.message);
    res.status(500).json({ error: "Failed to load batch" });
  }
}

// GET /api/product-imports/summary — overview stat cards.
async function getSummary(req, res) {
  try {
    const [pendingDrafts, batchesInProgress, batchTotals, usage] = await Promise.all([
      prisma.productDraft.count({ where: { approvalStatus: "PENDING" } }),
      prisma.productImportBatch.count({ where: { status: { in: ["PENDING_EXTRACTION", "PROCESSING"] } } }),
      prisma.productImportBatch.aggregate({
        _sum: { draftedCount: true, linkedCount: true, needsRateCount: true, needsBrandReviewCount: true, failedCount: true },
      }),
      prisma.agentUsage.aggregate({
        where: { agentName: BULK_AGENT_NAME },
        _sum: { costUsd: true, costInr: true },
      }),
    ]);

    res.json({
      pendingDrafts,
      batchesInProgress,
      totalDrafted: batchTotals._sum.draftedCount || 0,
      totalLinked: batchTotals._sum.linkedCount || 0,
      totalNeedsRate: batchTotals._sum.needsRateCount || 0,
      totalNeedsBrandReview: batchTotals._sum.needsBrandReviewCount || 0,
      totalFailed: batchTotals._sum.failedCount || 0,
      totalCostUsd: Number(usage._sum.costUsd || 0),
      totalCostInr: Number(usage._sum.costInr || 0),
    });
  } catch (err) {
    console.error("getSummary error:", err.message);
    res.status(500).json({ error: "Failed to load summary" });
  }
}

module.exports = {
  listDrafts,
  getDraft,
  approveDraftById,
  rejectDraftById,
  listBatches,
  getBatch,
  getSummary,
};
