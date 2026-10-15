// controllers/campaignController.js
//
// Module 6 — staff dashboard endpoints for the Campaigns page. Read-only
// views over CampaignTrigger and DynamicTemplate, plus approve/reject for
// the same approval queue the emailed link uses (both go through
// services/campaignTemplateService.js, so they can't drift apart).
//
// approvalToken is intentionally never returned here — it's the
// credential for the emailed approval link, not something a dashboard
// needs to display.

const { prisma } = require("../lib/prisma");
const { env } = require("../config/env");
const { listTemplates, getTemplate } = require("../lib/samvaadik/adapter");
const { approveAndSubmit, reject } = require("../services/campaignTemplateService");

const TRIGGER_SCENARIOS = ["BIRTHDAY", "REPLENISHMENT", "CROSS_SELL", "REVIEW_REMINDER", "WINBACK", "CUSTOM"];

function parsePaging(query) {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit) || 25, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

function customerName(customer) {
  if (!customer) return null;
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
  return name || customer.waPhone;
}

// One human-readable pipeline stage per template, computed from the four
// independent status fields, so the UI never has to reason about combinations.
function computeStage(t) {
  if (t.deleteStatus === "DELETED") return "DELETED";
  if (t.sendStatus === "SENT") return "SENT";
  if (t.sendStatus === "FAILED") return "SEND_FAILED";
  if (t.samvaadikSmId) return "SCHEDULED";
  if (t.metaStatus === "META_REJECTED") return "META_REJECTED";
  if (t.metaStatus === "SUBMITTED" || t.metaStatus === "META_APPROVED") return "META_PENDING";
  if (t.internalApprovalStatus === "REJECTED") return "REJECTED";
  if (t.internalApprovalStatus === "PENDING") return "AWAITING_APPROVAL";
  return "UNKNOWN";
}

function normalizeTemplate(t) {
  return {
    id: t.id,
    scenario: t.scenario,
    templateName: t.templateName,
    category: t.category,
    bodyDraft: t.bodyDraft,
    variables: Array.isArray(t.variables) ? t.variables : [],
    imageUrl: t.imageUrl || null,
    stage: computeStage(t),
    internalApprovalStatus: t.internalApprovalStatus,
    internalApprovedBy: t.internalApprovedBy,
    metaStatus: t.metaStatus,
    metaRejectionReason: t.metaRejectionReason,
    sendStatus: t.sendStatus,
    deleteStatus: t.deleteStatus,
    batchId: t.batchId,
    draftCostInr: t.draftCostInr === null ? null : Number(t.draftCostInr),
    draftCostUsd: t.draftCostUsd === null ? null : Number(t.draftCostUsd),
    createdAt: t.createdAt,
    sentAt: t.sentAt,
    deleteAfter: t.deleteAfter,
    customer: t.Customer
      ? { id: t.Customer.id, name: customerName(t.Customer), waPhone: t.Customer.waPhone }
      : null,
  };
}

function normalizeTrigger(t) {
  return {
    id: t.id,
    scenario: t.scenario,
    status: t.status,
    suppressedReason: t.suppressedReason,
    detectedAt: t.detectedAt,
    customer: t.Customer
      ? { id: t.Customer.id, name: customerName(t.Customer), waPhone: t.Customer.waPhone }
      : null,
  };
}

const TEMPLATE_INCLUDE = { Customer: { select: { id: true, firstName: true, lastName: true, waPhone: true } } };

// GET /api/campaigns/summary
async function getCampaignSummary(req, res) {
  try {
    const [triggerGroups, templateCounts, costAgg] = await Promise.all([
      prisma.campaignTrigger.groupBy({ by: ["scenario", "status"], _count: { _all: true } }),
      Promise.all([
        prisma.dynamicTemplate.count({ where: { internalApprovalStatus: "PENDING" } }),
        prisma.dynamicTemplate.count({ where: { metaStatus: { in: ["SUBMITTED", "META_APPROVED"] }, sendStatus: "PENDING", samvaadikSmId: null } }),
        prisma.dynamicTemplate.count({ where: { samvaadikSmId: { not: null }, sendStatus: "PENDING" } }),
        prisma.dynamicTemplate.count({ where: { sendStatus: "SENT" } }),
        prisma.dynamicTemplate.count({ where: { sendStatus: "FAILED" } }),
        prisma.dynamicTemplate.count({ where: { metaStatus: "META_REJECTED" } }),
      ]),
      prisma.dynamicTemplate.aggregate({ _sum: { draftCostInr: true } }),
    ]);

    const byScenario = {};
    for (const g of triggerGroups) {
      byScenario[g.scenario] = byScenario[g.scenario] || {};
      byScenario[g.scenario][g.status] = g._count._all;
    }

    const [awaitingApproval, awaitingMeta, scheduled, sent, failed, metaRejected] = templateCounts;

    res.json({
      byScenario,
      pipeline: { awaitingApproval, awaitingMeta, scheduled, sent, failed, metaRejected },
      draftCostInr: Number(costAgg._sum.draftCostInr || 0),
    });
  } catch (err) {
    console.error("getCampaignSummary error:", err.message);
    res.status(500).json({ error: "Failed to load campaign summary" });
  }
}

// GET /api/campaigns/triggers?scenario=&status=&page=&limit=
async function listCampaignTriggers(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req.query);
    const where = {};
    if (req.query.scenario && TRIGGER_SCENARIOS.includes(req.query.scenario)) where.scenario = req.query.scenario;
    if (req.query.status) where.status = req.query.status;

    const [rows, total] = await Promise.all([
      prisma.campaignTrigger.findMany({
        where,
        orderBy: { detectedAt: "desc" },
        skip,
        take: limit,
        include: { Customer: { select: { id: true, firstName: true, lastName: true, waPhone: true } } },
      }),
      prisma.campaignTrigger.count({ where }),
    ]);

    res.json({
      data: rows.map(normalizeTrigger),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error("listCampaignTriggers error:", err.message);
    res.status(500).json({ error: "Failed to load campaign triggers" });
  }
}

// GET /api/campaigns/templates?scenario=&approval=&page=&limit=
async function listCampaignTemplates(req, res) {
  try {
    const { page, limit, skip } = parsePaging(req.query);
    const where = {};
    if (req.query.scenario && TRIGGER_SCENARIOS.includes(req.query.scenario)) where.scenario = req.query.scenario;
    if (req.query.approval) where.internalApprovalStatus = req.query.approval;

    const [rows, total] = await Promise.all([
      prisma.dynamicTemplate.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: TEMPLATE_INCLUDE,
      }),
      prisma.dynamicTemplate.count({ where }),
    ]);

    res.json({
      data: rows.map(normalizeTemplate),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    console.error("listCampaignTemplates error:", err.message);
    res.status(500).json({ error: "Failed to load campaign templates" });
  }
}

// GET /api/campaigns/templates/:id
async function getCampaignTemplate(req, res) {
  try {
    const t = await prisma.dynamicTemplate.findUnique({ where: { id: req.params.id }, include: TEMPLATE_INCLUDE });
    if (!t) return res.status(404).json({ error: "Template not found" });
    res.json({ data: normalizeTemplate(t) });
  } catch (err) {
    console.error("getCampaignTemplate error:", err.message);
    res.status(500).json({ error: "Failed to load template" });
  }
}

// GET /api/campaigns/static/:scenario — the pre-approved Samvaadik template
// behind a static lane (BIRTHDAY / REPLENISHMENT), so staff can see the
// exact wording customers receive. Resolved by name, because the scheduler
// sends by name too (BIRTHDAY_TEMPLATE_NAME / REPLENISHMENT_TEMPLATE_NAME).
async function getStaticCampaignTemplate(req, res) {
  try {
    const scenario = req.params.scenario;
    const name = env.campaignTemplates[scenario];
    if (!scenario || name === undefined) {
      return res.status(404).json({ error: "Not a static campaign lane" });
    }
    if (!name) {
      return res.status(404).json({ error: `No template name configured for ${scenario}` });
    }

    const list = await listTemplates();
    const match = list.find((t) => t.name === name);
    if (!match) {
      return res.status(404).json({ error: `Template "${name}" not found on Samvaadik` });
    }

    const detail = await getTemplate(match.wt_id);
    const components = Array.isArray(detail.components) ? detail.components : [];
    const body = components.find((c) => c.type === "BODY");
    const header = components.find((c) => c.type === "HEADER");

    res.json({
      data: {
        scenario,
        templateName: detail.name,
        status: detail.status,
        category: detail.category,
        language: detail.language,
        bodyText: body?.text || "",
        exampleVariables: body?.example?.body_text?.[0] || [],
        headerFormat: header?.format || null,
        footerText: components.find((c) => c.type === "FOOTER")?.text || null,
      },
    });
  } catch (err) {
    console.error("getStaticCampaignTemplate error:", err.message);
    res.status(500).json({ error: "Failed to load template from Samvaadik" });
  }
}

function sendServiceError(res, err, fallbackMessage) {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error(fallbackMessage, err.message);
  return res.status(500).json({ error: fallbackMessage });
}

// POST /api/campaigns/templates/:id/approve
async function approveCampaignTemplate(req, res) {
  try {
    await approveAndSubmit(req.params.id, req.staffUser.email, req.staffUser.id);
    const t = await prisma.dynamicTemplate.findUnique({ where: { id: req.params.id }, include: TEMPLATE_INCLUDE });
    res.json({ data: normalizeTemplate(t) });
  } catch (err) {
    sendServiceError(res, err, "Failed to approve template");
  }
}

// POST /api/campaigns/templates/:id/reject
async function rejectCampaignTemplate(req, res) {
  try {
    await reject(req.params.id, req.staffUser.email, req.staffUser.id);
    const t = await prisma.dynamicTemplate.findUnique({ where: { id: req.params.id }, include: TEMPLATE_INCLUDE });
    res.json({ data: normalizeTemplate(t) });
  } catch (err) {
    sendServiceError(res, err, "Failed to reject template");
  }
}

module.exports = {
  getCampaignSummary,
  listCampaignTriggers,
  listCampaignTemplates,
  getCampaignTemplate,
  approveCampaignTemplate,
  rejectCampaignTemplate,
  getStaticCampaignTemplate,
};
