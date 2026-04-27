const { prisma } = require("../prisma");

function requireAccountMember(paramName = "accountId") {
  return async (req, res, next) => {
    const userId = req.auth?.userId;
    const accountId = req.params?.[paramName];

    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!accountId) return res.status(400).json({ error: "Missing accountId" });

    const member = await prisma.accountMember.findFirst({
      where: {
        userId,
        accountId,
        account: { deletedAt: null },
      },
      select: { role: true },
    });

    if (!member) return res.status(403).json({ error: "Not a member of this account" });

    req.memberRole = member.role;
    next();
  };
}

module.exports = { requireAccountMember };
