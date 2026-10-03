// controllers/agentUsageController.js
//
// Normalizes two different source tables into one shape so the frontend
// never has to know that Sales/Supplier usage lives in AgentUsage
// (keyed by conversationId, agentName "sales" / "SUPPLIER") while
// Insights usage lives in a separate InsightsUsage table (keyed by
// staffUserId, no agentName at all). Campaign agent is deliberately
// left out — a colleague owns that build.
const { prisma } = require("../lib/prisma");

const AGENTS = {
  sales: { table: "agentUsage", match: { agentName: "sales" } },
  supplier: { table: "agentUsage", match: { agentName: "SUPPLIER" } },
  insights: { table: "insightsUsage", match: {} },
};

function parseRange(query) {
  const where = {};
  if (query.from || query.to) {
    where.createdAt = {};
    if (query.from) where.createdAt.gte = new Date(query.from);
    if (query.to) where.createdAt.lte = new Date(query.to);
  }
  return where;
}

function parsePaging(query) {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit) || 25, 1), 100);
  return { page, limit, skip: (page - 1) * limit };
}

// Shared row shape, regardless of source table.
function normalizeRow(row, agent) {
  return {
    id: row.id,
    agent,
    label:
      agent === "insights"
        ? row.question
        : `Conversation ${String(row.conversationId || "").slice(0, 8)}`,
    model: row.model || null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd,
    costInr: row.costInr,
    toolCallCount: row.toolCallCount,
    outcome: row.outcome,
    createdAt: row.createdAt,
    // Only present for sales/supplier
    conversationId: row.conversationId || null,
    // Only present for insights
    staffUserId: row.staffUserId || null,
  };
}

// Groups InsightsUsage by staffUserId and joins the staff member's name/
// email, so the Insights tab can show "who is costing what" rather than
// just a system-wide total. Rows with no staffUserId (shouldn't normally
// happen, but requests can come in without req.staffUser attached) are
// grouped under a single "Unknown" entry rather than dropped silently.
async function getInsightsStaffBreakdown(where) {
  const grouped = await prisma.insightsUsage.groupBy({
    by: ["staffUserId"],
    where,
    _sum: { costUsd: true, costInr: true },
    _count: { _all: true },
  });

  const ids = grouped.map((g) => g.staffUserId).filter(Boolean);
  const staffUsers = ids.length
    ? await prisma.staffUser.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const staffById = Object.fromEntries(staffUsers.map((s) => [s.id, s]));

  return grouped
    .map((g) => {
      const staff = g.staffUserId ? staffById[g.staffUserId] : null;
      return {
        staffUserId: g.staffUserId,
        name: staff?.name || "Unknown",
        email: staff?.email || null,
        interactions: g._count._all,
        totalCostUsd: Number(g._sum.costUsd || 0),
        totalCostInr: Number(g._sum.costInr || 0),
      };
    })
    .sort((a, b) => b.totalCostInr - a.totalCostInr);
}

async function getAgentUsage(req, res) {
  const agent = req.params.agent;
  const config = AGENTS[agent];
  if (!config) {
    return res.status(404).json({
      error: `Unknown agent "${agent}". Expected one of: ${Object.keys(AGENTS).join(", ")}`,
    });
  }

  try {
    const { page, limit, skip } = parsePaging(req.query);
    const where = { ...config.match, ...parseRange(req.query) };
    const model = prisma[config.table];

    const [rows, total, aggregate, staffBreakdown] = await Promise.all([
      model.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        // Pull staff name/email alongside Insights rows, for display
        ...(agent === "insights"
          ? { include: { StaffUser: { select: { name: true, email: true } } } }
          : {}),
      }),
      model.count({ where }),
      model.aggregate({
        where,
        _sum: {
          inputTokens: true,
          outputTokens: true,
          costUsd: true,
          costInr: true,
          toolCallCount: true,
        },
      }),
      // Per-staff-member totals — only meaningful for Insights, since
      // Sales/Supplier usage isn't attributed to an individual staff
      // member (it's conversation-driven, not login-driven).
      agent === "insights"
        ? getInsightsStaffBreakdown(where)
        : Promise.resolve(null),
    ]);

    const sum = aggregate._sum;

    res.json({
      agent,
      summary: {
        totalInteractions: total,
        totalInputTokens: sum.inputTokens || 0,
        totalOutputTokens: sum.outputTokens || 0,
        totalToolCalls: sum.toolCallCount || 0,
        totalCostUsd: Number(sum.costUsd || 0),
        totalCostInr: Number(sum.costInr || 0),
        avgCostUsd: total > 0 ? Number(sum.costUsd || 0) / total : 0,
        avgCostInr: total > 0 ? Number(sum.costInr || 0) / total : 0,
      },
      data: rows.map((r) =>
        normalizeRow(
          agent === "insights"
            ? {
                ...r,
                question: r.StaffUser
                  ? `${r.StaffUser.name}: ${r.question}`
                  : r.question,
              }
            : r,
          agent,
        ),
      ),
      staffBreakdown,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("getAgentUsage error:", err);
    res.status(500).json({ error: "Failed to fetch agent usage" });
  }
}

// GET /api/agent-usage/summary — all three agents' totals in one call,
// for the overview cards at the top of the page without three round trips.
async function getAgentUsageSummary(req, res) {
  try {
    const where = parseRange(req.query);

    const results = await Promise.all(
      Object.entries(AGENTS).map(async ([agent, config]) => {
        const model = prisma[config.table];
        const agentWhere = { ...config.match, ...where };
        const [total, aggregate] = await Promise.all([
          model.count({ where: agentWhere }),
          model.aggregate({
            where: agentWhere,
            _sum: {
              costUsd: true,
              costInr: true,
              inputTokens: true,
              outputTokens: true,
            },
          }),
        ]);
        return [
          agent,
          {
            totalInteractions: total,
            totalCostUsd: Number(aggregate._sum.costUsd || 0),
            totalCostInr: Number(aggregate._sum.costInr || 0),
            totalInputTokens: aggregate._sum.inputTokens || 0,
            totalOutputTokens: aggregate._sum.outputTokens || 0,
          },
        ];
      }),
    );

    res.json(Object.fromEntries(results));
  } catch (err) {
    console.error("getAgentUsageSummary error:", err);
    res.status(500).json({ error: "Failed to fetch agent usage summary" });
  }
}

module.exports = { getAgentUsage, getAgentUsageSummary };
