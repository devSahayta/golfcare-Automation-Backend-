const { prisma } = require("../lib/prisma");

async function addUser(req, res) {
  const { id, email, givenName, familyName, name } = req.body || {};

  if (!id || !email) {
    return res.status(400).json({ error: "id and email are required" });
  }

  const resolvedName =
    name || [givenName, familyName].filter(Boolean).join(" ") || email;

  try {
    const staffUser = await prisma.staffUser.upsert({
      where: { id },
      update: { email, name: resolvedName },
      create: { id, email, name: resolvedName },
    });
    res.status(200).json({ staffUser });
  } catch {
    res.status(500).json({ error: "Failed to sync user" });
  }
}

async function fetchUsers(_req, res) {
  try {
    const staffUsers = await prisma.staffUser.findMany({
      orderBy: { createdAt: "desc" },
    });
    res.json({ staffUsers });
  } catch {
    res.status(500).json({ error: "Failed to fetch users" });
  }
}

async function fetchUserById(req, res) {
  const { id } = req.params;
  try {
    const staffUser = await prisma.staffUser.findUnique({ where: { id } });
    if (!staffUser) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ staffUser });
  } catch {
    res.status(500).json({ error: "Failed to fetch user" });
  }
}

module.exports = { addUser, fetchUsers, fetchUserById };
