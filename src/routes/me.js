const { Router } = require("express");
const { z } = require("zod");
const bcrypt = require("bcrypt");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const { isAdminUserEmail } = require("../lib/adminUser");
const { processPendingSchedulesForUser } = require("../services/processPendingSchedules");
const { getMaintenanceState, setMaintenanceState } = require("../services/globalAppState");
const { logApp } = require("../lib/fileLogger");
const { syncNewMemberCategoryAccess } = require("../services/categoryMemberAccess");
const {
  MAX_ACCOUNTS_PER_USER,
  ACCOUNT_LIMIT_REACHED_MESSAGE,
  countActiveAccountMemberships,
} = require("../lib/accountLimits");

const meRouter = Router();

/** Public: clients poll this (no auth) for global maintenance lock. */
meRouter.get("/public/maintenance", async (_req, res, next) => {
  try {
    const s = await getMaintenanceState();
    return res.json({
      maintenanceMode: s.maintenanceMode,
      message: s.message,
    });
  } catch (err) {
    next(err);
  }
});

const patchMaintenanceSchema = z.object({
  enabled: z.boolean(),
  message: z.string().max(500).optional().nullable(),
});

meRouter.patch("/admin/maintenance", requireAuth, async (req, res, next) => {
  try {
    const adminEmail = process.env.ADMIN_EMAIL?.trim();
    if (!adminEmail) {
      return res.status(503).json({ error: "ADMIN_EMAIL is not configured on the server" });
    }
    const user = await prisma.user.findUnique({
      where: { id: req.auth.userId },
      select: { email: true },
    });
    if (!user || !isAdminUserEmail(user.email)) {
      return res.status(403).json({ error: "Not allowed to perform this operation" });
    }
    const body = patchMaintenanceSchema.parse(req.body ?? {});
    const s = await setMaintenanceState({
      enabled: body.enabled,
      message: body.message,
    });
    return res.json({
      maintenanceMode: s.maintenanceMode,
      message: s.message,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid body", details: err.flatten() });
    }
    next(err);
  }
});

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

  await processPendingSchedulesForUser(userId).catch((err) => {
    // eslint-disable-next-line no-console -- operational visibility
    console.error("[schedules] GET /me", err?.message || err);
    logApp("ERROR", "Schedules", "GET /me", err instanceof Error ? err : { message: String(err) });
  });

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

meRouter.get("/me/membership-notices", requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    const [rows, invitations, accountMembershipCount] = await Promise.all([
      prisma.membershipNotice.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          kind: true,
          accountId: true,
          accountName: true,
          createdAt: true,
        },
      }),
      prisma.pendingAccountInvitation.findMany({
        where: { invitedUserId: userId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          accountId: true,
          createdAt: true,
          account: { select: { name: true } },
          invitedBy: {
            select: { id: true, email: true, displayName: true },
          },
        },
      }),
      countActiveAccountMemberships(prisma, userId),
    ]);

    return res.json({
      notices: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
      invitations: invitations.map((i) => ({
        id: i.id,
        accountId: i.accountId,
        accountName: i.account.name,
        invitedBy: i.invitedBy,
        createdAt: i.createdAt.toISOString(),
      })),
      accountMembershipCount,
    });
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/account-invitations/:invitationId/accept", requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    const { invitationId } = req.params;

    const inv = await prisma.pendingAccountInvitation.findFirst({
      where: { id: invitationId, invitedUserId: userId },
      select: {
        id: true,
        accountId: true,
        invitedUserId: true,
      },
    });
    if (!inv) return res.status(404).json({ error: "Invitation not found" });

    const account = await prisma.account.findFirst({
      where: { id: inv.accountId, deletedAt: null },
      select: { id: true },
    });
    if (!account) {
      await prisma.pendingAccountInvitation.delete({ where: { id: inv.id } });
      return res.status(410).json({ error: "That account no longer exists" });
    }

    const already = await prisma.accountMember.findUnique({
      where: { userId_accountId: { userId, accountId: inv.accountId } },
    });
    if (already) {
      await prisma.pendingAccountInvitation.delete({ where: { id: inv.id } });
      return res.status(409).json({ error: "You are already a member of this account" });
    }

    const membershipCount = await countActiveAccountMemberships(prisma, userId);
    if (membershipCount >= MAX_ACCOUNTS_PER_USER) {
      return res.status(403).json({
        error: ACCOUNT_LIMIT_REACHED_MESSAGE,
        code: "ACCOUNT_LIMIT_REACHED",
      });
    }

    const created = await prisma.$transaction(async (tx) => {
      await tx.pendingAccountInvitation.delete({ where: { id: inv.id } });
      return tx.accountMember.create({
        data: {
          userId,
          accountId: inv.accountId,
          role: "MEMBER",
        },
        select: {
          role: true,
          joinedAt: true,
          user: {
            select: { id: true, email: true, displayName: true },
          },
        },
      });
    });

    await syncNewMemberCategoryAccess(prisma, inv.accountId, userId);

    return res.status(201).json({ member: created });
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/account-invitations/:invitationId/decline", requireAuth, async (req, res, next) => {
  try {
    const userId = req.auth.userId;
    const { invitationId } = req.params;

    const del = await prisma.pendingAccountInvitation.deleteMany({
      where: { id: invitationId, invitedUserId: userId },
    });
    if (del.count === 0) return res.status(404).json({ error: "Invitation not found" });

    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

meRouter.post("/me/membership-notices/ack", requireAuth, async (req, res, next) => {
  try {
    const body = z.object({ ids: z.array(z.string().min(1)).min(1) }).parse(req.body ?? {});
    await prisma.membershipNotice.deleteMany({
      where: { userId: req.auth.userId, id: { in: body.ids } },
    });
    return res.status(204).send();
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Invalid body", details: err.flatten() });
    }
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
