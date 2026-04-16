const jwt = require("jsonwebtoken");
const { config } = require("../config");
const { prisma } = require("../prisma");

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) return res.status(401).json({ error: "Missing access token" });

  let payload;
  try {
    payload = jwt.verify(token, config.jwtAccessSecret);
  } catch {
    return res.status(401).json({ error: "Invalid or expired access token" });
  }

  prisma.user
    .findFirst({
      where: { id: payload.userId, deletedAt: null },
      select: { id: true },
    })
    .then((user) => {
      if (!user) {
        return res.status(401).json({ error: "Account has been deleted or is unavailable" });
      }
      req.auth = payload;
      next();
    })
    .catch(() => res.status(500).json({ error: "Internal server error" }));
}

module.exports = { requireAuth };
