const { Router } = require("express");
const { z } = require("zod");
const { randomUUID } = require("crypto");

const { prisma } = require("../prisma");
const { destinationAmountMinor } = require("../lib/transferFx");
const { requireAuth } = require("../middleware/auth");
const { requireAccountMember } = require("../middleware/requireAccountMember");
const { ensureTransferCategories } = require("../services/ensureTransferCategories");
const { seedDefaultWallets } = require("../services/seedDefaultWallets");
const { walletBalanceMinor } = require("../services/walletBalance");
const {
  throwIfExpenseWouldCauseNegativeCashBalance,
} = require("../services/nonNegativeCashBalance");

const accountExtrasRouter = Router({ mergeParams: true });

const createWalletSchema = z.object({
  emoji: z.string().trim().min(1).max(16),
});

const patchWalletSchema = z.object({
  emoji: z.string().trim().min(1).max(16),
});

const reorderWalletsSchema = z.object({
  orderedWalletIds: z.array(z.string().min(1)).min(1),
});

const structuredTransferSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("WALLET"),
    fromWalletId: z.string().min(1),
    toWalletId: z.string().min(1),
    amountMinor: z.number().int().positive(),
    note: z.string().max(500).optional(),
    occurredAt: z.coerce.date().optional(),
  }),
  z.object({
    kind: z.literal("ACCOUNT"),
    toAccountId: z.string().min(1),
    amountMinor: z.number().int().positive(),
    fromWalletId: z.string().min(1).optional(),
    toWalletId: z.string().min(1).optional(),
    fxRate: z.number().positive().optional(),
    note: z.string().max(500).optional(),
    occurredAt: z.coerce.date().optional(),
  }),
]);

accountExtrasRouter.use(requireAuth);
accountExtrasRouter.use(requireAccountMember("accountId"));

accountExtrasRouter.get("/wallets", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { walletsEnabled: true, walletMigrationPending: true },
    });
    if (!account) return res.status(404).json({ error: "Account not found" });

    const wallets = await prisma.accountWallet.findMany({
      where: { accountId, deletedAt: null },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        emoji: true,
        sortOrder: true,
        internalKey: true,
        createdAt: true,
      },
    });

    const balances = await Promise.all(
      wallets.map((w) => walletBalanceMinor(prisma, w.id))
    );

    return res.json({
      walletsEnabled: account.walletsEnabled,
      walletMigrationPending: account.walletMigrationPending,
      wallets: wallets.map((w, i) => ({ ...w, balanceMinor: balances[i] })),
    });
  } catch (err) {
    next(err);
  }
});

accountExtrasRouter.post("/wallets", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const userId = req.auth.userId;
    const body = createWalletSchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { walletsEnabled: true, walletMigrationPending: true },
    });
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (!account.walletsEnabled && !account.walletMigrationPending) {
      return res.status(400).json({ error: "Enable wallets for this account first" });
    }

    const maxSort = await prisma.accountWallet.aggregate({
      where: { accountId, deletedAt: null },
      _max: { sortOrder: true },
    });
    const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

    const wallet = await prisma.accountWallet.create({
      data: {
        accountId,
        emoji: body.emoji,
        sortOrder,
      },
      select: {
        id: true,
        emoji: true,
        sortOrder: true,
        internalKey: true,
        createdAt: true,
      },
    });

    const balanceMinor = await walletBalanceMinor(prisma, wallet.id);

    await prisma.auditLog.create({
      data: {
        userId,
        action: "CREATE",
        entity: "AccountWallet",
        entityId: wallet.id,
        meta: { accountId },
      },
    });

    return res.status(201).json({ wallet: { ...wallet, balanceMinor } });
  } catch (err) {
    next(err);
  }
});

/** Set `sortOrder` to each wallet’s index in `orderedWalletIds` (left-to-right on the client). */
accountExtrasRouter.put("/wallets/reorder", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const userId = req.auth.userId;
    const body = reorderWalletsSchema.parse(req.body);

    const existing = await prisma.accountWallet.findMany({
      where: { accountId, deletedAt: null },
      select: { id: true },
    });
    const validIds = new Set(existing.map((e) => e.id));
    if (body.orderedWalletIds.length !== validIds.size) {
      return res.status(400).json({
        error: "orderedWalletIds must list every wallet exactly once",
      });
    }
    for (const id of body.orderedWalletIds) {
      if (!validIds.has(id)) {
        return res.status(400).json({ error: "Unknown wallet id in orderedWalletIds" });
      }
    }

    await prisma.$transaction(
      body.orderedWalletIds.map((id, index) =>
        prisma.accountWallet.update({
          where: { id },
          data: { sortOrder: index },
        })
      )
    );

    await prisma.auditLog.create({
      data: {
        userId,
        action: 'UPDATE',
        entity: 'Account',
        entityId: accountId,
        meta: { walletReorder: body.orderedWalletIds },
      },
    });

    return res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

accountExtrasRouter.patch("/wallets/:walletId", async (req, res, next) => {
  try {
    const { accountId, walletId } = req.params;
    const userId = req.auth.userId;
    const body = patchWalletSchema.parse(req.body);

    const existing = await prisma.accountWallet.findFirst({
      where: { id: walletId, accountId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: "Wallet not found" });

    const wallet = await prisma.accountWallet.update({
      where: { id: walletId },
      data: { emoji: body.emoji },
      select: {
        id: true,
        emoji: true,
        sortOrder: true,
        internalKey: true,
        createdAt: true,
      },
    });

    const balanceMinor = await walletBalanceMinor(prisma, wallet.id);

    await prisma.auditLog.create({
      data: {
        userId,
        action: "UPDATE",
        entity: "AccountWallet",
        entityId: wallet.id,
        meta: { accountId },
      },
    });

    return res.json({ wallet: { ...wallet, balanceMinor } });
  } catch (err) {
    next(err);
  }
});

accountExtrasRouter.delete("/wallets/:walletId", async (req, res, next) => {
  try {
    const { accountId, walletId } = req.params;
    const userId = req.auth.userId;

    const existing = await prisma.accountWallet.findFirst({
      where: { id: walletId, accountId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: "Wallet not found" });

    const bal = await walletBalanceMinor(prisma, walletId);
    if (bal !== 0) {
      return res.status(400).json({
        error: "Wallet balance must be zero before it can be deleted",
        balanceMinor: bal,
      });
    }

    await prisma.accountWallet.update({
      where: { id: walletId },
      data: { deletedAt: new Date() },
    });

    await prisma.auditLog.create({
      data: {
        userId,
        action: "DELETE",
        entity: "AccountWallet",
        entityId: walletId,
        meta: { accountId, soft: true },
      },
    });

    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

accountExtrasRouter.get("/search", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const qRaw = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!qRaw) {
      return res.json({
        query: "",
        categories: [],
        noteTransactions: [],
        amountMatches: null,
        instrumentTransactions: [],
      });
    }

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true, currency: true, investingEnabled: true },
    });
    if (!account) return res.status(404).json({ error: "Account not found" });

    /** Avoid odd DB/driver issues with NUL / extreme length; keep echo as original trim. */
    const q = qRaw.replace(/\u0000/g, "").slice(0, 200);
    if (!q) {
      return res.json({
        query: qRaw,
        categories: [],
        noteTransactions: [],
        amountMatches: null,
        instrumentTransactions: [],
      });
    }
    /** MySQL: do not use `mode: "insensitive"` here — it can throw / 500 with Prisma + MariaDB. */
    const nameMatch = { contains: q };

    const categories = await prisma.category.findMany({
      where: {
        accountId,
        deletedAt: null,
        OR: [
          { name: nameMatch },
          ...(account.investingEnabled
            ? [
                {
                  wishlistItems: {
                    some: {
                      instrument: {
                        OR: [
                          { name: nameMatch },
                          { providerSymbol: nameMatch },
                        ],
                      },
                    },
                  },
                },
              ]
            : []),
        ],
      },
      select: {
        id: true,
        type: true,
        name: true,
        icon: true,
        color: true,
        internalKey: true,
      },
      take: 40,
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });

    const noteTransactions = await prisma.transaction.findMany({
      where: {
        accountId,
        deletedAt: null,
        revokedAt: null,
        note: { contains: q },
      },
      select: {
        id: true,
        type: true,
        amountMinor: true,
        occurredAt: true,
        note: true,
        categoryId: true,
        instrumentId: true,
        transferGroupId: true,
        transferPairId: true,
      },
      take: 50,
      orderBy: { occurredAt: "desc" },
    });

    const num = Number.parseFloat(String(q).replace(",", "."));
    let amountMatches = null;
    if (Number.isFinite(num)) {
      const targetMinor = Math.round(Math.abs(num) * 100);
      const isNeg = num < 0;

      const baseWhere = {
        accountId,
        deletedAt: null,
        revokedAt: null,
        amountMinor: targetMinor,
      };

      if (isNeg) {
        const expenseOnly = await prisma.transaction.findMany({
          where: { ...baseWhere, type: "EXPENSE" },
          select: {
            id: true,
            type: true,
            amountMinor: true,
            occurredAt: true,
            note: true,
            categoryId: true,
            instrumentId: true,
            transferGroupId: true,
            transferPairId: true,
          },
          take: 80,
          orderBy: { occurredAt: "desc" },
        });
        amountMatches = { query: num, negative: true, transactions: expenseOnly };
      } else {
        const [incomeRows, investRows, expenseRows] = await Promise.all([
          prisma.transaction.findMany({
            where: { ...baseWhere, type: "INCOME" },
            select: {
              id: true,
              type: true,
              amountMinor: true,
              occurredAt: true,
              note: true,
              categoryId: true,
              instrumentId: true,
              transferGroupId: true,
              transferPairId: true,
            },
            take: 40,
            orderBy: { occurredAt: "desc" },
          }),
          prisma.transaction.findMany({
            where: { ...baseWhere, type: "INVESTMENT" },
            select: {
              id: true,
              type: true,
              amountMinor: true,
              occurredAt: true,
              note: true,
              categoryId: true,
              instrumentId: true,
              transferGroupId: true,
              transferPairId: true,
            },
            take: 40,
            orderBy: { occurredAt: "desc" },
          }),
          prisma.transaction.findMany({
            where: { ...baseWhere, type: "EXPENSE" },
            select: {
              id: true,
              type: true,
              amountMinor: true,
              occurredAt: true,
              note: true,
              categoryId: true,
              instrumentId: true,
              transferGroupId: true,
              transferPairId: true,
            },
            take: 80,
            orderBy: { occurredAt: "desc" },
          }),
        ]);

        const transferWhere = {
          accountId,
          deletedAt: null,
          revokedAt: null,
          amountMinor: targetMinor,
          OR: [{ transferGroupId: { not: null } }, { transferPairId: { not: null } }],
        };
        const transferRows = await prisma.transaction.findMany({
          where: transferWhere,
          select: {
            id: true,
            type: true,
            amountMinor: true,
            occurredAt: true,
            note: true,
            categoryId: true,
            instrumentId: true,
            transferGroupId: true,
            transferPairId: true,
          },
          take: 40,
          orderBy: { occurredAt: "desc" },
        });

        const seen = new Set();
        const ordered = [];
        const pushUnique = (rows) => {
          for (const r of rows) {
            if (!seen.has(r.id)) {
              seen.add(r.id);
              ordered.push(r);
            }
          }
        };
        pushUnique(incomeRows);
        pushUnique(transferRows);
        pushUnique(investRows);
        pushUnique(expenseRows);

        amountMatches = { query: num, negative: false, transactions: ordered };
      }
    }

    const instrumentTransactions =
      account.investingEnabled
        ? await prisma.transaction.findMany({
            where: {
              accountId,
              deletedAt: null,
              revokedAt: null,
              instrumentId: { not: null },
              instrument: {
                OR: [{ name: nameMatch }, { providerSymbol: nameMatch }],
              },
            },
            select: {
              id: true,
              type: true,
              amountMinor: true,
              occurredAt: true,
              note: true,
              categoryId: true,
              instrumentId: true,
              transferGroupId: true,
              transferPairId: true,
              instrument: {
                select: {
                  id: true,
                  name: true,
                  providerSymbol: true,
                },
              },
            },
            take: 50,
            orderBy: { occurredAt: "desc" },
          })
        : [];

    const tagTx = (row) => ({
      ...row,
      currency: account.currency,
      occurredAt: row.occurredAt.toISOString(),
      isTransferLeg: Boolean(row.transferGroupId || row.transferPairId),
    });

    return res.json({
      query: qRaw.slice(0, 200),
      categories,
      noteTransactions: noteTransactions.map(tagTx),
      amountMatches: amountMatches
        ? {
            ...amountMatches,
            transactions: amountMatches.transactions.map(tagTx),
          }
        : null,
      instrumentTransactions: instrumentTransactions.map(tagTx),
    });
  } catch (err) {
    next(err);
  }
});

accountExtrasRouter.post("/transfer", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const userId = req.auth.userId;
    const body = structuredTransferSchema.parse(req.body);

    const fromAccount = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true, currency: true, walletsEnabled: true },
    });
    if (!fromAccount) return res.status(404).json({ error: "Account not found" });

    const occurredAt = body.occurredAt ?? new Date();
    const note = body.note ?? null;

    if (body.kind === "WALLET") {
      if (!fromAccount.walletsEnabled) {
        return res.status(400).json({ error: "Wallets are not enabled for this account" });
      }
      if (body.fromWalletId === body.toWalletId) {
        return res.status(400).json({ error: "fromWalletId and toWalletId must differ" });
      }

      const [wFrom, wTo] = await Promise.all([
        prisma.accountWallet.findFirst({
          where: { id: body.fromWalletId, accountId, deletedAt: null },
          select: { id: true },
        }),
        prisma.accountWallet.findFirst({
          where: { id: body.toWalletId, accountId, deletedAt: null },
          select: { id: true },
        }),
      ]);
      if (!wFrom || !wTo) {
        return res.status(400).json({ error: "Invalid wallet id for this account" });
      }

      const pairId = randomUUID();

      const result = await prisma.$transaction(async (tx) => {
        const { sendCategoryId, receiveCategoryId } = await ensureTransferCategories(
          tx,
          accountId
        );

        await throwIfExpenseWouldCauseNegativeCashBalance(
          tx,
          accountId,
          body.amountMinor,
          body.fromWalletId
        );

        const outTx = await tx.transaction.create({
          data: {
            accountId,
            type: "EXPENSE",
            amountMinor: body.amountMinor,
            currency: fromAccount.currency,
            occurredAt,
            note,
            categoryId: sendCategoryId,
            createdByUserId: userId,
            walletId: body.fromWalletId,
            transferPairId: pairId,
          },
        });

        const inTx = await tx.transaction.create({
          data: {
            accountId,
            type: "INCOME",
            amountMinor: body.amountMinor,
            currency: fromAccount.currency,
            occurredAt,
            note,
            categoryId: receiveCategoryId,
            createdByUserId: userId,
            walletId: body.toWalletId,
            transferPairId: pairId,
          },
        });

        await tx.auditLog.create({
          data: {
            userId,
            action: "TRANSFER_CREATE",
            entity: "TransactionPair",
            entityId: pairId,
            meta: {
              accountId,
              kind: "WALLET",
              fromWalletId: body.fromWalletId,
              toWalletId: body.toWalletId,
              amountMinor: body.amountMinor,
            },
          },
        });

        return { transferPairId: pairId, fromTransaction: outTx, toTransaction: inTx };
      });

      return res.status(201).json(result);
    }

    // ACCOUNT
    if (body.toAccountId === accountId) {
      return res.status(400).json({ error: "toAccountId must differ from this account" });
    }

    const toAccount = await prisma.account.findFirst({
      where: { id: body.toAccountId, deletedAt: null },
      select: { id: true, currency: true, walletsEnabled: true },
    });
    if (!toAccount) return res.status(404).json({ error: "Destination account not found" });

    const toMember = await prisma.accountMember.findUnique({
      where: { userId_accountId: { userId, accountId: toAccount.id } },
      select: { role: true },
    });
    if (!toMember) {
      return res.status(403).json({ error: "You must be a member of the destination account" });
    }

    const sameCurrency = fromAccount.currency === toAccount.currency;
    let fxRate = body.fxRate ?? null;
    if (!sameCurrency && !fxRate) {
      return res.status(400).json({ error: "fxRate is required when currencies differ" });
    }
    if (sameCurrency) fxRate = null;

    if (fromAccount.walletsEnabled) {
      if (!body.fromWalletId) {
        return res.status(400).json({ error: "fromWalletId is required when this account uses wallets" });
      }
      const w = await prisma.accountWallet.findFirst({
        where: { id: body.fromWalletId, accountId, deletedAt: null },
        select: { id: true },
      });
      if (!w) return res.status(400).json({ error: "Invalid fromWalletId" });
    } else if (body.fromWalletId) {
      return res.status(400).json({ error: "fromWalletId is only valid when wallets are enabled" });
    }

    if (toAccount.walletsEnabled) {
      if (!body.toWalletId) {
        return res.status(400).json({
          error: "toWalletId is required when the destination account uses wallets",
        });
      }
      const w = await prisma.accountWallet.findFirst({
        where: { id: body.toWalletId, accountId: toAccount.id, deletedAt: null },
        select: { id: true },
      });
      if (!w) return res.status(400).json({ error: "Invalid toWalletId" });
    } else if (body.toWalletId) {
      return res.status(400).json({ error: "toWalletId is only valid when destination has wallets enabled" });
    }

    let toAmountMinor;
    try {
      toAmountMinor = destinationAmountMinor({
        amountMinor: body.amountMinor,
        fxRate,
        sameCurrency,
      });
    } catch (err) {
      if (err && err.code === "FX_AMOUNT_ROUNDS_TO_ZERO") {
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }

    const result = await prisma.$transaction(async (tx) => {
      await throwIfExpenseWouldCauseNegativeCashBalance(
        tx,
        fromAccount.id,
        body.amountMinor,
        body.fromWalletId ?? null
      );

      const { sendCategoryId } = await ensureTransferCategories(tx, accountId);
      const { receiveCategoryId } = await ensureTransferCategories(tx, toAccount.id);

      const transferGroup = await tx.transferGroup.create({
        data: {
          initiatedById: userId,
          fromAccountId: fromAccount.id,
          toAccountId: toAccount.id,
          fxRate,
          note,
        },
      });

      const fromTx = await tx.transaction.create({
        data: {
          accountId: fromAccount.id,
          type: "EXPENSE",
          amountMinor: body.amountMinor,
          currency: fromAccount.currency,
          occurredAt,
          note,
          categoryId: sendCategoryId,
          createdByUserId: userId,
          transferGroupId: transferGroup.id,
          walletId: body.fromWalletId ?? null,
        },
      });

      const toTx = await tx.transaction.create({
        data: {
          accountId: toAccount.id,
          type: "INCOME",
          amountMinor: toAmountMinor,
          currency: toAccount.currency,
          occurredAt,
          note,
          categoryId: receiveCategoryId,
          createdByUserId: userId,
          transferGroupId: transferGroup.id,
          walletId: body.toWalletId ?? null,
        },
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: "TRANSFER_CREATE",
          entity: "TransferGroup",
          entityId: transferGroup.id,
          meta: {
            fromAccountId: fromAccount.id,
            toAccountId: toAccount.id,
            amountMinorFrom: body.amountMinor,
            amountMinorTo: toAmountMinor,
          },
        },
      });

      return { transferGroup, fromTransaction: fromTx, toTransaction: toTx };
    });

    return res.status(201).json(result);
  } catch (err) {
    if (err && err.code === "NEGATIVE_CASH_BALANCE") {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = { accountExtrasRouter };
