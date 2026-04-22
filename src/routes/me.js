const { Router } = require("express");
const { z } = require("zod");
const bcrypt = require("bcrypt");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const { isAdminUserEmail } = require("../lib/adminUser");
const { processPendingSchedulesForUser } = require("../services/processPendingSchedules");

const meRouter = Router();

const patchMeSchema = z.object({
  displayName: z.string().max(80).optional(),
  email: z.string().email().max(255).optional(),
  firstDayOfWeek: z.number().int().min(0).max(6).optional(),
});

const lockPairSchema = z.object({
  password: z.string().min(4).max(200),
  confirmPassword: z.string().min(4).max(200),
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
      firstDayOfWeek: true,
      appLockEnabled: true,
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
    if (body.firstDayOfWeek !== undefined) data.firstDayOfWeek = body.firstDayOfWeek;

    const user = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        email: true,
        displayName: true,
        createdAt: true,
        personalAccountId: true,
        firstDayOfWeek: true,
        appLockEnabled: true,
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

meRouter.post("/me/process-schedules", requireAuth, async (req, res, next) => {
  try {
    await processPendingSchedulesForUser(req.auth.userId);
    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/app-lock/verify", requireAuth, async (req, res, next) => {
  try {
    const body = z.object({ password: z.string().min(4).max(200) }).parse(req.body);
    const u = await prisma.user.findFirst({
      where: { id: req.auth.userId, deletedAt: null },
      select: { appLockEnabled: true, appLockPasswordHash: true },
    });
    if (!u?.appLockEnabled || !u.appLockPasswordHash) {
      return res.status(400).json({ error: "App lock is not enabled" });
    }
    const ok = await bcrypt.compare(body.password, u.appLockPasswordHash);
    if (!ok) return res.status(401).json({ error: "Invalid app lock password" });
    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/app-lock/enable", requireAuth, async (req, res, next) => {
  try {
    const body = lockPairSchema.parse(req.body);
    if (body.password !== body.confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }
    const u = await prisma.user.findFirst({
      where: { id: req.auth.userId, deletedAt: null },
      select: { id: true, appLockEnabled: true },
    });
    if (!u) return res.status(401).json({ error: "Unauthorized" });
    if (u.appLockEnabled) {
      return res.status(400).json({ error: "App lock is already enabled" });
    }
    const appLockPasswordHash = await bcrypt.hash(body.password, 12);
    const user = await prisma.user.update({
      where: { id: u.id },
      data: { appLockEnabled: true, appLockPasswordHash },
      select: {
        id: true,
        email: true,
        displayName: true,
        createdAt: true,
        personalAccountId: true,
        firstDayOfWeek: true,
        appLockEnabled: true,
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

meRouter.post("/me/app-lock/disable", requireAuth, async (req, res, next) => {
  try {
    const body = lockPairSchema.parse(req.body);
    if (body.password !== body.confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }
    const u = await prisma.user.findFirst({
      where: { id: req.auth.userId, deletedAt: null },
      select: { id: true, appLockEnabled: true, appLockPasswordHash: true },
    });
    if (!u) return res.status(401).json({ error: "Unauthorized" });
    if (!u.appLockEnabled || !u.appLockPasswordHash) {
      return res.status(400).json({ error: "App lock is not enabled" });
    }
    const ok = await bcrypt.compare(body.password, u.appLockPasswordHash);
    if (!ok) return res.status(401).json({ error: "Invalid app lock password" });
    const user = await prisma.user.update({
      where: { id: u.id },
      data: { appLockEnabled: false, appLockPasswordHash: null },
      select: {
        id: true,
        email: true,
        displayName: true,
        createdAt: true,
        personalAccountId: true,
        firstDayOfWeek: true,
        appLockEnabled: true,
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
