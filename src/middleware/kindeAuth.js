const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");
const { prisma } = require("../lib/prisma");
const { env } = require("../config/env");

const client = jwksClient({
  jwksUri: `${env.kindeDomain}/.well-known/jwks.json`,
});

function getKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

async function requireStaffAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(token, getKey, {}, async (err, decoded) => {
    if (err) return res.status(401).json({ error: "Invalid token" });

    const staffUser = await prisma.staffUser.findUnique({
      where: { id: decoded.sub },
    });

    if (!staffUser || !staffUser.isActive) {
      return res.status(403).json({ error: "Not an authorized staff member" });
    }

    req.staffUser = staffUser;
    next();
  });
}

module.exports = { requireStaffAuth };
