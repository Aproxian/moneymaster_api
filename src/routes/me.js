const { Router } = require("express");
const { z } = require("zod");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const { isAdminUserEmail } = require("../lib/adminUser");

const meRouter = Router();

const patchMeSchema = z.object({
  displayName: z.string().max(80).optional(),
  email: z.string().email().max(255).optional(),
});

meRouter.get("/me", requireAuth, async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      displayName: true,
      createdAt: true,
      personalAccountId: true,
    },
  });

  if (!user) return res.status(401).json({ error: "Unauthorized" });

  return res.json({
    user: {
      ...user,
      isAdmin: isAdminUserEmail(user.email),
    },
  });
});

meRouter.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    const body = patchMeSchema.parse(req.body);

    if (Object.keys(body).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const active = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!active) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (body.email) {
      const taken = await prisma.user.findFirst({
        where: {
          email: body.email,
          NOT: { id: userId },
          deletedAt: null,
        },
        select: { id: true },
      });
      if (taken) {
        return res.status(409).json({ error: "Email is already in use" });
      }
    }

    const data = {};
    if (body.displayName !== undefined) {
      const t = body.displayName.trim();
      data.displayName = t.length ? t : null;
    }
    if (body.email !== undefined) data.email = body.email.trim().toLowerCase();

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        displayName: true,
        createdAt: true,
        personalAccountId: true,
      },
    });

    return res.json({
      user: {
        ...user,
        isAdmin: isAdminUserEmail(user.email),
      },
    });
  } catch (err) {
    next(err);
  }
});

meRouter.delete("/me", requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    const now = new Date();

    const alive = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { id: true },
    });
    if (!alive) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    await prisma.$transaction(async (tx) => {
      const memberships = await tx.accountMember.findMany({
        where: { userId },
        select: { accountId: true, role: true, joinedAt: true },
      });

      for (const m of memberships) {
        const { accountId } = m;

        const allMembers = await tx.accountMember.findMany({
          where: { accountId },
          select: { userId: true, role: true, joinedAt: true },
          orderBy: { joinedAt: "asc" },
        });

        const others = allMembers.filter((x) => x.userId !== userId);

        if (others.length === 0) {
          await tx.account.update({
            where: { id: accountId },
            data: { deletedAt: now },
          });
        } else if (m.role === "OWNER") {
          const successor = [...others].sort(
            (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime()
          )[0];
          await tx.accountMember.update({
            where: {
              userId_accountId: { userId: successor.userId, accountId },
            },
            data: { role: "OWNER" },
          });
        }

        await tx.accountMember.delete({
          where: { userId_accountId: { userId, accountId } },
        });
      }

      await tx.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      });

      await tx.user.update({
        where: { id: userId },
        data: {
          deletedAt: now,
          personalAccountId: null,
        },
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: "DELETE",
          entity: "User",
          entityId: userId,
          meta: { soft: true },
        },
      });
    });

    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = { meRouter };
