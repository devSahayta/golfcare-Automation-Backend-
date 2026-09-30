// controllers/userController.js
const { prisma } = require("../lib/prisma");

async function addUser(req, res) {
  const { id, email, givenName, familyName, name } = req.body || {};

  if (!id || !email) {
    return res.status(400).json({ error: "id and email are required" });
  }

  const resolvedName =
    name || [givenName, familyName].filter(Boolean).join(" ") || email;

  try {
    // Gate on email — the field an admin pre-provisions before anyone's
    // first login. Never create a row here: an email with no existing
    // StaffUser means no account was set up for them, and that must stay
    // a rejection (403), not an auto-signup. StaffUser.id is our own
    // primary key (referenced by InsightsUsage) — Kinde's id is never
    // written into it.
    const existing = await prisma.staffUser.findUnique({ where: { email } });

    if (!existing) {
      return res.status(403).json({ error: "No account found for this email" });
    }

    if (!existing.isActive) {
      return res
        .status(403)
        .json({ error: "This account has been deactivated" });
    }

    const staffUser = await prisma.staffUser.update({
      where: { email },
      data: { name: resolvedName, kindeUserId: id },
    });

    res.status(200).json({ staffUser });
  } catch (err) {
    console.error("addUser error:", err);
    res.status(500).json({ error: "Failed to sync user" });
  }
}

async function fetchUsers(req, res) {
  const { limit, offset } = req.query;

  try {
    const take = Math.min(Number(limit) || 50, 200);
    const skip = Number(offset) || 0;

    const [staffUsers, total] = await Promise.all([
      prisma.staffUser.findMany({
        take,
        skip,
        orderBy: { createdAt: "desc" },
      }),
      prisma.staffUser.count(),
    ]);

    res.json({ staffUsers, total, limit: take, offset: skip });
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
