// controllers/agentUsageController.js
//
// Normalizes three different source tables into one shape so the
// frontend never has to know where each agent's usage actually lives:
//   - Sales / Supplier -> AgentUsage (keyed by conversationId; agentName
//     is "sales" / "SUPPLIER" — Supplier has no explicit agentName in its
//     config, so it falls back to context.participantType)
//   - Insights         -> InsightsUsage (keyed by staffUserId)
//   - Campaign         -> DynamicTemplate (the cost of the isolated Claude
//     drafting call lives directly on the row as draft* columns, since a
//     proactive campaign draft has no Conversation to hang an AgentUsage
//     off of). That is DRAFTING cost only — any Meta/WhatsApp per-message
//     send fee isn't tracked anywhere in the schema.
const { prisma } = require("../lib/prisma");

// Standard column names, shared by AgentUsage and InsightsUsage.
const STANDARD_FIELDS = {
  inputTokens: "inputTokens",
  outputTokens: "outputTokens",
  costUsd: "costUsd",
  costInr: "costInr",
  toolCallCount: "toolCallCount",
};

const AGENTS = {
  sales: {
    table: "agentUsage",
    match: { agentName: "sales" },
    fields: STANDARD_FIELDS,
  },
  supplier: {
    table: "agentUsage",
    match: { agentName: "SUPPLIER" },
    fields: STANDARD_FIELDS,
  },
  insights: {
    table: "insightsUsage",
    match: {},
    fields: STANDARD_FIELDS,
  },
  campaign: {
    table: "dynamicTemplate",
    match: {},
    fields: {
      inputTokens: "draftInputTokens",
      outputTokens: "draftOutputTokens",
      costUsd: "draftCostUsd",
      costInr: "draftCostInr",
      toolCallCount: null, // campaign drafting makes no tool calls
    },
  },
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

// Builds the { _sum: { <realColumn>: true } } object for a given agent,
// skipping any field that agent doesn't have (e.g. campaign tool calls).
function buildSumSelect(fields) {
  const select = {};
  for (const col of Object.values(fields)) {
    if (col) select[col] = true;
  }
  return select;
}

// Reads a normalized value out of an aggregate's _sum using the agent's
// real column name for it.
function readSum(sum, fields, key) {
  const col = fields[key];
  return col ? sum[col] || 0 : 0;
}

function humanize(str = "") {
  const s = String(str).replace(/_/g, " ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// One status word for a campaign draft, in order of "how far did it get /
// where did it stop", since DynamicTemplate has no single outcome column.
function campaignOutcome(row) {
  if (row.internalApprovalStatus === "REJECTED") return "rejected";
  if (row.metaStatus === "META_REJECTED") return "meta_rejected";
  if (row.sendStatus === "SENT") return "sent";
  if (row.sendStatus === "FAILED") return "failed";
  if (row.internalApprovalStatus === "PENDING") return "awaiting_approval";
  return "pending";
}

function customerName(c) {
  if (!c) return "Unknown customer";
  return (
    [c.firstName, c.lastName].filter(Boolean).join(" ") ||
    c.waPhone ||
    "Unknown customer"
  );
}

// Shared row shape, regardless of source table.
function normalizeRow(row, agent) {
  if (agent === "campaign") {
    return {
      id: row.id,
      agent,
      label: `${humanize(row.scenario)} · ${customerName(row.Customer)}`,
      model: null,
      inputTokens: row.draftInputTokens || 0,
      outputTokens: row.draftOutputTokens || 0,
      costUsd: row.draftCostUsd,
      costInr: row.draftCostInr,
      toolCallCount: 0,
      outcome: campaignOutcome(row),
      createdAt: row.createdAt,
      conversationId: null,
      staffUserId: null,
    };
  }

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
    conversationId: row.conversationId || null,
    staffUserId: row.staffUserId || null,
  };
}

// Groups InsightsUsage by staffUserId and joins the staff member's name/
// email, so the Insights tab can show "who is costing what" rather than
// just a system-wide total. Rows with no staffUserId (older rows logged
// before requireStaffAuth reliably attached req.staffUser) are grouped
// under a single "Unknown" entry rather than dropped silently.
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

function includeFor(agent) {
  if (agent === "insights") {
    return { include: { StaffUser: { select: { name: true, email: true } } } };
  }
  if (agent === "campaign") {
    return {
      include: {
        Customer: {
          select: { firstName: true, lastName: true, waPhone: true },
        },
      },
    };
  }
  return {};
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
        ...includeFor(agent),
      }),
      model.count({ where }),
      model.aggregate({
        where,
        _sum: buildSumSelect(config.fields),
      }),
      // Per-staff-member totals — only meaningful for Insights, since the
      // other agents' usage isn't attributed to an individual staff login.
      agent === "insights"
        ? getInsightsStaffBreakdown(where)
        : Promise.resolve(null),
    ]);

    const sum = aggregate._sum;
    const f = config.fields;
    const totalCostUsd = Number(readSum(sum, f, "costUsd"));
    const totalCostInr = Number(readSum(sum, f, "costInr"));

    res.json({
      agent,
      summary: {
        totalInteractions: total,
        totalInputTokens: readSum(sum, f, "inputTokens"),
        totalOutputTokens: readSum(sum, f, "outputTokens"),
        totalToolCalls: readSum(sum, f, "toolCallCount"),
        totalCostUsd,
        totalCostInr,
        avgCostUsd: total > 0 ? totalCostUsd / total : 0,
        avgCostInr: total > 0 ? totalCostInr / total : 0,
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

// GET /api/agent-usage/summary — every agent's totals in one call, for
// the overview cards at the top of the page without N round trips.
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
            _sum: buildSumSelect(config.fields),
          }),
        ]);
        const sum = aggregate._sum;
        const f = config.fields;
        return [
          agent,
          {
            totalInteractions: total,
            totalCostUsd: Number(readSum(sum, f, "costUsd")),
            totalCostInr: Number(readSum(sum, f, "costInr")),
            totalInputTokens: readSum(sum, f, "inputTokens"),
            totalOutputTokens: readSum(sum, f, "outputTokens"),
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
