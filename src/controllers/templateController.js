// controllers/templateController.js
//
// Module 8 — Settings > Templates screen. No local DB table for this —
// Meta-approved templates live in Samvaadik, this just exposes their
// existing listTemplates() adapter call to the Dashboard.

const { listTemplates } = require("../lib/samvaadik/adapter");

async function getTemplates(_req, res) {
  try {
    const templates = await listTemplates();
    res.json({ templates });
  } catch (err) {
    console.error("getTemplates error:", err);
    res.status(502).json({ error: "Failed to fetch templates from Samvaadik" });
  }
}

module.exports = { getTemplates };
