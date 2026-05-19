const { Router } = require("express");
const { z } = require("zod");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const { requireAccountMember } = require("../middleware/requireAccountMember");
const { requireAccountRole } = require("../middleware/requireAccountRole");
const { seedDefaultCategories } = require("../services/seedDefaultCategories");
const {
  ensureInvestmentCategories,
  removeInvestmentCategories,
} = require("../services/investingCategories");
const { seedDefaultWallets } = require("../services/seedDefaultWallets");
const {
  throwIfCannotEnablePreventNegativeCashBalance,
} = require("../services/nonNegativeCashBalance");
const {
  getPrimaryOwnerUserId,
  syncNewMemberCategoryAccess,
  sortMembersForLockUi,
} = require("../services/categoryMemberAccess");

const accountsRouter = Router();

/**
 * @param {import('@prisma/client').PrismaClient} prismaClient
 * @param {string} accountId
 * @param {string} userId
 * @param {string} memberRole
 */
async function loadAccountDetail(prismaClient, accountId, userId, memberRole) {
  const me = await prismaClient.user.findUnique({
    where: { id: userId },
    select: { personalAccountId: true },
  });
  const account = await prismaClient.account.findFirst({
    where: { id: accountId, deletedAt: null },
    select: {
      id: true,
      name: true,
      currency: true,
      investingEnabled: true,
      walletsEnabled: true,
      walletMigrationPending: true,
      preventNegativeCashBalance: true,
      isBusiness: true,
      companyName: true,
      companyLegalName: true,
      companyTaxId: true,
      companyAddress: true,
      companyNotes: true,
      createdAt: true,
      updatedAt: true,
      wallets: {
        where: { deletedAt: null },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          emoji: true,
          sortOrder: true,
          internalKey: true,
          createdAt: true,
        },
      },
    },
  });
  if (!account) return null;
  const personalId = me?.personalAccountId ?? null;
  const { wallets, ...rest } = account;
  return {
    account: {
      ...rest,
      wallets,
      isPersonal: personalId != null && account.id === personalId,
      myRole: memberRole,
    },
  };
}

const createAccountSchema = z.object({
  name: z.string().min(1).max(120),
  currency: z.string().min(1).max(10),
  investingEnabled: z.boolean().optional(),
  isBusiness: z.boolean().optional(),
  companyName: z.string().max(200).optional().nullable(),
  companyLegalName: z.string().max(200).optional().nullable(),
  companyTaxId: z.string().max(80).optional().nullable(),
  companyAddress: z.string().max(8000).optional().nullable(),
  companyNotes: z.string().max(8000).optional().nullable(),
});

const patchAccountSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  walletsEnabled: z.boolean().optional(),
  investingEnabled: z.boolean().optional(),
  isBusiness: z.boolean().optional(),
  companyName: z.string().max(200).optional().nullable(),
  companyLegalName: z.string().max(200).optional().nullable(),
  companyTaxId: z.string().max(80).optional().nullable(),
  companyAddress: z.string().max(8000).optional().nullable(),
  companyNotes: z.string().max(8000).optional().nullable(),
  startWalletMigration: z.boolean().optional(),
  completeWalletMigration: z.boolean().optional(),
  cancelWalletMigration: z.boolean().optional(),
  preventNegativeCashBalance: z.boolean().optional(),
});

const addMemberSchema = z.object({
  userId: z.string().min(1).max(40),
});

const changeCurrencySchema = z.object({
  newCurrency: z.string().min(1).max(10),
  // "1 oldCurrency = fxRate newCurrency"
  fxRate: z.number().positive(),
});

accountsRouter.use(requireAuth);

accountsRouter.get("/", async (req, res, next) => {
  try {
    const userId = req.auth.userId;

    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { personalAccountId: true },
    });

    const accounts = await prisma.account.findMany({
      where: {
        deletedAt: null,
        members: {
          some: {
            userId,
          },
        },
      },
      select: {
        id: true,
        name: true,
        currency: true,
        investingEnabled: true,
        walletsEnabled: true,
        walletMigrationPending: true,
        isBusiness: true,
        companyName: true,
        createdAt: true,
        updatedAt: true,
        members: {
          where: { userId },
          take: 1,
          select: { role: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const personalId = me?.personalAccountId ?? null;

    return res.json({
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        currency: a.currency,
        investingEnabled: a.investingEnabled,
        walletsEnabled: a.walletsEnabled,
        walletMigrationPending: a.walletMigrationPending,
        isBusiness: a.isBusiness,
        companyName: a.companyName,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        isPersonal: personalId != null && a.id === personalId,
        myRole: a.members[0]?.role ?? null,
      })),
      personalAccountId: personalId,
    });
  } catch (err) {
    next(err);
  }
});

accountsRouter.post("/", async (req, res, next) => {
  try {
    const body = createAccountSchema.parse(req.body);
    const userId = req.auth.userId;
    const currency = body.currency.trim().toUpperCase();
    const isBusiness = Boolean(body.isBusiness);
    const investingEnabled = body.investingEnabled ?? true;

    const account = await prisma.$transaction(async (tx) => {
      const created = await tx.account.create({
        data: {
          name: body.name.trim(),
          currency,
          investingEnabled,
          isBusiness,
          companyName: isBusiness ? body.companyName?.trim() || null : null,
          companyLegalName: isBusiness ? body.companyLegalName?.trim() || null : null,
          companyTaxId: isBusiness ? body.companyTaxId?.trim() || null : null,
          companyAddress: isBusiness ? body.companyAddress?.trim() || null : null,
          companyNotes: isBusiness ? body.companyNotes?.trim() || null : null,
          members: {
            create: {
              userId,
              role: "OWNER",
            },
          },
        },
        select: {
          id: true,
          name: true,
          currency: true,
          investingEnabled: true,
          isBusiness: true,
          companyName: true,
          companyLegalName: true,
          companyTaxId: true,
          companyAddress: true,
          companyNotes: true,
          createdAt: true,
        },
      });
      await seedDefaultCategories(tx, created.id, { investingEnabled, createdByUserId: userId });
      return created;
    });

    return res.status(201).json({ account });
  } catch (err) {
    next(err);
  }
});

accountsRouter.get(
  "/:accountId/members",
  requireAccountMember("accountId"),
  async (req, res, next) => {
    try {
      const { accountId } = req.params;

      const members = await prisma.accountMember.findMany({
        where: { accountId },
        select: {
          role: true,
          joinedAt: true,
          user: {
            select: { id: true, email: true, displayName: true },
          },
        },
        orderBy: { joinedAt: "asc" },
      });

      res.set("Cache-Control", "no-store, private");
      return res.json({ members: sortMembersForLockUi(members) });
    } catch (err) {
      next(err);
    }
  }
);

accountsRouter.post(
  "/:accountId/members",
  requireAccountMember("accountId"),
  requireAccountRole("OWNER", "ADMIN"),
  async (req, res, next) => {
    try {
      const { accountId } = req.params;
      const userId = req.auth.userId;
      const body = addMemberSchema.parse(req.body);

      const inviter = await prisma.user.findUnique({
        where: { id: userId },
        select: { personalAccountId: true },
      });

      if (inviter?.personalAccountId && inviter.personalAccountId === accountId) {
        return res.status(403).json({
          error: "Members cannot be added to your personal account",
        });
      }

      if (body.userId === userId) {
        return res.status(400).json({ error: "You are already a member of this account" });
      }

      const target = await prisma.user.findUnique({
        where: { id: body.userId },
        select: { id: true },
      });
      if (!target) return res.status(404).json({ error: "User not found" });

      const existing = await prisma.accountMember.findUnique({
        where: { userId_accountId: { userId: body.userId, accountId } },
      });
      if (existing) return res.status(409).json({ error: "User is already a member" });

      const accountBrief = await prisma.account.findFirst({
        where: { id: accountId, deletedAt: null },
        select: { name: true },
      });

      const created = await prisma.accountMember.create({
        data: {
          userId: body.userId,
          accountId,
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

      await prisma.membershipNotice.create({
        data: {
          userId: body.userId,
          kind: "ADDED",
          accountId,
          accountName: accountBrief?.name ?? null,
        },
      });

      await prisma.auditLog.create({
        data: {
          userId,
          action: "MEMBER_ADD",
          entity: "Account",
          entityId: accountId,
          meta: { addedUserId: body.userId },
        },
      });

      await syncNewMemberCategoryAccess(prisma, accountId, body.userId);

      return res.status(201).json({ member: created });
    } catch (err) {
      next(err);
    }
  }
);

accountsRouter.delete(
  "/:accountId/members/:memberUserId",
  requireAccountMember("accountId"),
  requireAccountRole("OWNER", "ADMIN"),
  async (req, res, next) => {
    try {
      const { accountId, memberUserId } = req.params;
      const requesterId = req.auth.userId;

      const target = await prisma.accountMember.findUnique({
        where: { userId_accountId: { userId: memberUserId, accountId } },
        select: { role: true },
      });
      if (!target) return res.status(404).json({ error: "Member not found" });

      if (req.memberRole === "ADMIN" && (target.role === "OWNER" || target.role === "ADMIN")) {
        return res.status(403).json({ error: "Only an owner can remove this member" });
      }

      const ownerCount = await prisma.accountMember.count({
        where: { accountId, role: "OWNER" },
      });
      if (target.role === "OWNER" && ownerCount <= 1) {
        return res.status(400).json({ error: "Cannot remove the only owner of this account" });
      }

      const accountBrief = await prisma.account.findFirst({
        where: { id: accountId },
        select: { name: true },
      });

      const now = new Date();
      await prisma.$transaction(async (tx) => {
        await tx.accountMember.delete({
          where: { userId_accountId: { userId: memberUserId, accountId } },
        });
        await tx.categoryMemberAccess.deleteMany({
          where: {
            userId: memberUserId,
            category: { accountId },
          },
        });
        await tx.pendingTransactionSchedule.updateMany({
          where: {
            accountId,
            createdByUserId: memberUserId,
            status: "PENDING",
            cancelledAt: null,
          },
          data: { status: "CANCELLED", cancelledAt: now },
        });
      });

      await prisma.membershipNotice.create({
        data: {
          userId: memberUserId,
          kind: "REMOVED",
          accountId,
          accountName: accountBrief?.name ?? null,
        },
      });

      await prisma.auditLog.create({
        data: {
          userId: requesterId,
          action: "MEMBER_REMOVE",
          entity: "Account",
          entityId: accountId,
          meta: { removedUserId: memberUserId },
        },
      });

      return res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

accountsRouter.patch(
  "/:accountId",
  requireAccountMember("accountId"),
  requireAccountRole("OWNER", "ADMIN"),
  async (req, res, next) => {
    try {
      const { accountId } = req.params;
      const body = patchAccountSchema.parse(req.body);
      const userId = req.auth.userId;
      const memberRole = req.memberRole;

      const existing = await prisma.account.findFirst({
        where: { id: accountId, deletedAt: null },
        select: {
          id: true,
          investingEnabled: true,
          walletsEnabled: true,
          walletMigrationPending: true,
          preventNegativeCashBalance: true,
        },
      });
      if (!existing) return res.status(404).json({ error: "Account not found" });

      const migCount =
        (body.cancelWalletMigration ? 1 : 0) +
        (body.completeWalletMigration ? 1 : 0) +
        (body.startWalletMigration ? 1 : 0);
      if (migCount > 1) {
        return res.status(400).json({ error: "Send only one wallet migration action at a time" });
      }

      if (body.cancelWalletMigration) {
        const row = await prisma.account.findFirst({
          where: { id: accountId, deletedAt: null },
          select: { walletMigrationPending: true },
        });
        if (row?.walletMigrationPending) {
          await prisma.$transaction(async (tx) => {
            await tx.transaction.updateMany({
              where: { accountId, deletedAt: null },
              data: { walletId: null },
            });
            await tx.accountWallet.updateMany({
              where: { accountId, deletedAt: null },
              data: { deletedAt: new Date() },
            });
            await tx.account.update({
              where: { id: accountId },
              data: { walletMigrationPending: false, walletsEnabled: false },
            });
          });
        }
        const payload = await loadAccountDetail(prisma, accountId, userId, memberRole);
        if (!payload) return res.status(404).json({ error: "Account not found" });
        return res.json(payload);
      }

      if (body.completeWalletMigration) {
        await prisma.$transaction(async (tx) => {
          await tx.account.update({
            where: { id: accountId },
            data: { walletMigrationPending: false, walletsEnabled: true },
          });
        });
        const payload = await loadAccountDetail(prisma, accountId, userId, memberRole);
        if (!payload) return res.status(404).json({ error: "Account not found" });
        return res.json(payload);
      }

      if (body.startWalletMigration) {
        if (existing.walletsEnabled) {
          return res.status(400).json({ error: "Wallets are already enabled for this account" });
        }
        await prisma.$transaction(async (tx) => {
          await tx.account.update({
            where: { id: accountId },
            data: { walletMigrationPending: true, walletsEnabled: false },
          });
          await seedDefaultWallets(tx, accountId);
        });
        const payload = await loadAccountDetail(prisma, accountId, userId, memberRole);
        if (!payload) return res.status(404).json({ error: "Account not found" });
        return res.json(payload);
      }

      if (body.investingEnabled === false && existing.investingEnabled) {
        const holdings = await prisma.holding.findMany({
          where: { accountId, deletedAt: null },
          select: { quantity: true },
        });
        const hasOpen = holdings.some((h) => Number(h.quantity) > 1e-12);
        if (hasOpen) {
          return res.status(400).json({
            error:
              "Cash out or close all investment holdings before disabling investing for this account",
          });
        }
      }

      if (
        body.preventNegativeCashBalance === true &&
        existing.preventNegativeCashBalance !== true
      ) {
        try {
          await throwIfCannotEnablePreventNegativeCashBalance(
            prisma,
            accountId
          );
        } catch (e) {
          if (e && e.code === "NEGATIVE_BALANCE_FOR_LOCK") {
            return res.status(400).json({ error: e.message });
          }
          throw e;
        }
      }

      const data = {};
      if (body.name !== undefined) data.name = body.name.trim();
      if (body.walletsEnabled !== undefined) data.walletsEnabled = body.walletsEnabled;
      if (body.investingEnabled !== undefined) data.investingEnabled = body.investingEnabled;
      if (body.isBusiness !== undefined) data.isBusiness = body.isBusiness;
      if (body.companyName !== undefined) data.companyName = body.companyName?.trim() || null;
      if (body.companyLegalName !== undefined) {
        data.companyLegalName = body.companyLegalName?.trim() || null;
      }
      if (body.companyTaxId !== undefined) data.companyTaxId = body.companyTaxId?.trim() || null;
      if (body.companyAddress !== undefined) {
        data.companyAddress = body.companyAddress?.trim() || null;
      }
      if (body.companyNotes !== undefined) data.companyNotes = body.companyNotes?.trim() || null;

      if (body.preventNegativeCashBalance !== undefined) {
        data.preventNegativeCashBalance = body.preventNegativeCashBalance;
      }

      if (body.isBusiness === false) {
        data.companyName = null;
        data.companyLegalName = null;
        data.companyTaxId = null;
        data.companyAddress = null;
        data.companyNotes = null;
      }

      if (body.walletsEnabled === false) {
        data.walletMigrationPending = false;
      }
      if (body.walletsEnabled === true && !existing.walletsEnabled) {
        data.walletMigrationPending = false;
      }

      await prisma.$transaction(async (tx) => {
        await tx.account.update({
          where: { id: accountId },
          data,
        });

        if (body.investingEnabled === false && existing.investingEnabled) {
          await removeInvestmentCategories(tx, accountId);
        }
        if (body.investingEnabled === true && !existing.investingEnabled) {
          const ownerId = await getPrimaryOwnerUserId(tx, accountId);
          await ensureInvestmentCategories(tx, accountId, { createdByUserId: ownerId });
        }

        if (body.walletsEnabled === false && existing.walletsEnabled) {
          await tx.transaction.updateMany({
            where: { accountId, deletedAt: null },
            data: { walletId: null },
          });
          await tx.accountWallet.updateMany({
            where: { accountId, deletedAt: null },
            data: { deletedAt: new Date() },
          });
        }

        if (body.walletsEnabled === true && !existing.walletsEnabled) {
          await seedDefaultWallets(tx, accountId);
        }
      });

      const payload = await loadAccountDetail(prisma, accountId, userId, memberRole);
      if (!payload) return res.status(404).json({ error: "Account not found" });
      return res.json(payload);
    } catch (err) {
      next(err);
    }
  }
);

accountsRouter.get("/:accountId", requireAccountMember("accountId"), async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const userId = req.auth.userId;

    const me = await prisma.user.findUnique({
      where: { id: userId },
      select: { personalAccountId: true },
    });

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: {
        id: true,
        name: true,
        currency: true,
        investingEnabled: true,
        walletsEnabled: true,
        walletMigrationPending: true,
        isBusiness: true,
        companyName: true,
        companyLegalName: true,
        companyTaxId: true,
        companyAddress: true,
        companyNotes: true,
        createdAt: true,
        updatedAt: true,
        wallets: {
          where: { deletedAt: null },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            emoji: true,
            sortOrder: true,
            internalKey: true,
            createdAt: true,
          },
        },
      },
    });

    if (!account) return res.status(404).json({ error: "Account not found" });

    const personalId = me?.personalAccountId ?? null;
    const { wallets, ...rest } = account;
    return res.json({
      account: {
        ...rest,
        wallets,
        isPersonal: personalId != null && account.id === personalId,
        myRole: req.memberRole,
      },
    });
  } catch (err) {
    next(err);
  }
});

accountsRouter.get(
  "/:accountId/overview",
  requireAccountMember("accountId"),
  async (req, res, next) => {
    try {
      const { accountId } = req.params;

      const account = await prisma.account.findFirst({
        where: { id: accountId, deletedAt: null },
        select: {
          id: true,
          name: true,
          currency: true,
          investingEnabled: true,
          walletsEnabled: true,
          walletMigrationPending: true,
        },
      });

      if (!account) return res.status(404).json({ error: "Account not found" });

      const walletIdRaw =
        typeof req.query.walletId === "string" && req.query.walletId.trim()
          ? req.query.walletId.trim()
          : undefined;
      let walletIdFilter = undefined;
      if (walletIdRaw) {
        if (!account.walletsEnabled && !account.walletMigrationPending) {
          return res.status(400).json({ error: "walletId filter requires wallets to be enabled" });
        }
        const w = await prisma.accountWallet.findFirst({
          where: { id: walletIdRaw, accountId, deletedAt: null },
          select: { id: true },
        });
        if (!w) return res.status(400).json({ error: "Invalid walletId" });
        walletIdFilter = walletIdRaw;
      }

      /** All-wallets (*): omit same-account wallet↔wallet legs; cross-account transfers use transferGroupId only. */
      const omitWalletInternalTransferPairs =
        !walletIdFilter &&
        (account.walletsEnabled || account.walletMigrationPending);

      const fromParam = req.query.from;
      const toParam = req.query.to;

      const from =
        typeof fromParam === "string" && fromParam
          ? new Date(fromParam)
          : undefined;
      const to =
        typeof toParam === "string" && toParam ? new Date(toParam) : undefined;

      if (from && isNaN(from.getTime())) {
        return res.status(400).json({ error: "Invalid from date" });
      }
      if (to && isNaN(to.getTime())) {
        return res.status(400).json({ error: "Invalid to date" });
      }

      const where = {
        accountId: account.id,
        deletedAt: null,
        revokedAt: null,
        ...(walletIdFilter ? { walletId: walletIdFilter } : {}),
        ...(omitWalletInternalTransferPairs ? { transferPairId: null } : {}),
        ...(from || to
          ? {
              occurredAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      };

      const grouped = await prisma.transaction.groupBy({
        by: ["type"],
        where,
        _sum: {
          amountMinor: true,
        },
      });

      let incomeMinor = 0;
      let expenseMinor = 0;
      for (const g of grouped) {
        const sum = g._sum.amountMinor || 0;
        if (g.type === "INCOME") incomeMinor = sum;
        if (g.type === "EXPENSE") expenseMinor = sum;
      }

      const balanceMinor = incomeMinor - expenseMinor;

      let totalInvestmentsValueMinor = 0;
      let unrealizedPnLMinor = 0;
      const investmentPositions = [];

      const period = {
        from: from ? from.toISOString() : null,
        to: to ? to.toISOString() : null,
        walletId: walletIdFilter ?? null,
      };

      if (!account.investingEnabled) {
        return res.json({
          account,
          period,
          totals: {
            incomeMinor,
            expenseMinor,
            balanceMinor,
            currency: account.currency,
          },
          investments: {
            totalInvestmentsValueMinor: 0,
            unrealizedPnLMinor: 0,
            positions: [],
          },
        });
      }

      // Investments valuation
      const holdings = await prisma.holding.findMany({
        where: {
          accountId: account.id,
          deletedAt: null,
        },
        select: {
          id: true,
          instrumentId: true,
          categoryId: true,
          quantity: true,
          costBasisMinor: true,
          instrument: {
            select: {
              id: true,
              name: true,
              provider: true,
              providerSymbol: true,
              currency: true,
            },
          },
          category: {
            select: {
              id: true,
              type: true,
              name: true,
              icon: true,
              color: true,
            },
          },
        },
      });

      for (const holding of holdings) {
        const latestQuote = await prisma.quoteCache.findFirst({
          where: {
            instrumentId: holding.instrumentId,
          },
          orderBy: {
            asOf: "desc",
          },
          select: {
            price: true,
            currency: true,
            asOf: true,
          },
        });

        if (!latestQuote) {
          investmentPositions.push({
            holdingId: holding.id,
            instrument: holding.instrument,
            quantity: holding.quantity,
            costBasisMinor: holding.costBasisMinor,
            latestQuote: null,
            marketValueMinor: null,
            unrealizedPnLMinor: null,
          });
          continue;
        }

        const marketValueMinor =
          holding.quantity && latestQuote.price
            ? Math.round(
                Number(holding.quantity) * Number(latestQuote.price) * 100
              )
            : 0;

        const posPnL = marketValueMinor - holding.costBasisMinor;
        totalInvestmentsValueMinor += marketValueMinor;
        unrealizedPnLMinor += posPnL;

        investmentPositions.push({
          holdingId: holding.id,
          instrument: holding.instrument,
          quantity: holding.quantity,
          costBasisMinor: holding.costBasisMinor,
          latestQuote,
          marketValueMinor,
          unrealizedPnLMinor: posPnL,
        });
      }

      return res.json({
        account,
        period,
        totals: {
          incomeMinor,
          expenseMinor,
          balanceMinor,
          currency: account.currency,
        },
        investments: {
          /** Sum of position market values (minor units), from latest quotes. */
          totalInvestmentsValueMinor,
          /** Sum of (marketValue − costBasis) per holding with a quote. */
          unrealizedPnLMinor,
          positions: investmentPositions,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

accountsRouter.post(
  "/:accountId/change-currency",
  requireAccountMember("accountId"),
  async (req, res, next) => {
    try {
      const { accountId } = req.params;
      const userId = req.auth.userId;

      if (req.memberRole !== "OWNER") {
        return res
          .status(403)
          .json({ error: "Only account OWNER can change currency" });
      }

      const body = changeCurrencySchema.parse(req.body);

      const account = await prisma.account.findFirst({
        where: { id: accountId, deletedAt: null },
        select: { id: true, currency: true },
      });

      if (!account) return res.status(404).json({ error: "Account not found" });

      if (account.currency === body.newCurrency) {
        return res
          .status(400)
          .json({ error: "Account is already in this currency" });
      }

      const { newCurrency, fxRate } = body;

      const result = await prisma.$transaction(async (tx) => {
        const oldCurrency = account.currency;

        const txns = await tx.transaction.findMany({
          where: {
            accountId: account.id,
            deletedAt: null,
          },
          select: {
            id: true,
            amountMinor: true,
          },
        });

        for (const t of txns) {
          const converted = Math.round(t.amountMinor * fxRate);
          await tx.transaction.update({
            where: { id: t.id },
            data: {
              amountMinor: converted,
              currency: newCurrency,
            },
          });
        }

        const currencyChange = await tx.accountCurrencyChange.create({
          data: {
            accountId: account.id,
            changedById: userId,
            oldCurrency,
            newCurrency,
            fxRate,
          },
        });

        await tx.account.update({
          where: { id: account.id },
          data: {
            currency: newCurrency,
          },
        });

        await tx.auditLog.create({
          data: {
            userId,
            action: "CURRENCY_CHANGE",
            entity: "Account",
            entityId: account.id,
            meta: {
              oldCurrency,
              newCurrency,
              fxRate,
              accountId: account.id,
              affectedTransactions: txns.length,
              currencyChangeId: currencyChange.id,
            },
          },
        });

        return {
          accountId: account.id,
          oldCurrency,
          newCurrency,
          fxRate,
          affectedTransactions: txns.length,
        };
      });

      return res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

accountsRouter.delete(
  "/:accountId",
  requireAccountMember("accountId"),
  requireAccountRole("OWNER"),
  async (req, res, next) => {
    try {
      const { accountId } = req.params;
      const userId = req.auth.userId;

      const me = await prisma.user.findUnique({
        where: { id: userId },
        select: { personalAccountId: true },
      });

      if (me?.personalAccountId && me.personalAccountId === accountId) {
        return res.status(400).json({ error: "Your personal account cannot be deleted" });
      }

      const existing = await prisma.account.findFirst({
        where: { id: accountId, deletedAt: null },
        select: { id: true, name: true },
      });

      if (!existing) return res.status(404).json({ error: "Account not found" });

      const otherMembers = await prisma.accountMember.findMany({
        where: { accountId },
        select: { userId: true },
      });

      await prisma.account.update({
        where: { id: accountId },
        data: { deletedAt: new Date() },
      });

      const noticeRows = otherMembers
        .filter((m) => m.userId !== userId)
        .map((m) => ({
          userId: m.userId,
          kind: "ACCOUNT_DELETED",
          accountId,
          accountName: existing.name ?? null,
        }));
      if (noticeRows.length > 0) {
        await prisma.membershipNotice.createMany({ data: noticeRows });
      }

      return res.status(204).send();
    } catch (err) {
      next(err);
    }
  }
);

module.exports = { accountsRouter };

