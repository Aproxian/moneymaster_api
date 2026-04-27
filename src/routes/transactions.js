const { Router } = require("express");
const { z } = require("zod");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const { requireAccountMember } = require("../middleware/requireAccountMember");

// Mounted at /accounts/:accountId/transactions
const transactionsRouter = Router({ mergeParams: true });

const createTransactionSchema = z.object({
  type: z.enum(["INCOME", "EXPENSE"]),
  amountMinor: z.number().int().positive(),
  currency: z.string().min(1).max(10).optional(),
  occurredAt: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
  categoryId: z.string().min(1),
  walletId: z.string().min(1).optional(),
});

transactionsRouter.use(requireAuth);
transactionsRouter.use(requireAccountMember("accountId"));

transactionsRouter.get("/", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const take = Math.min(
      200,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 100)
    );

    const walletIdRaw =
      typeof req.query.walletId === "string" && req.query.walletId.trim()
        ? req.query.walletId.trim()
        : undefined;

    let walletIdFilter = undefined;
    if (walletIdRaw) {
      const w = await prisma.accountWallet.findFirst({
        where: { id: walletIdRaw, accountId, deletedAt: null },
        select: { id: true },
      });
      if (!w) {
        return res.status(400).json({ error: "Invalid walletId for this account" });
      }
      walletIdFilter = walletIdRaw;
    }

    const categoryIdRaw =
      typeof req.query.categoryId === "string" && req.query.categoryId.trim()
        ? req.query.categoryId.trim()
        : undefined;

    let categoryIdFilter = undefined;
    if (categoryIdRaw) {
      const cat = await prisma.category.findFirst({
        where: {
          id: categoryIdRaw,
          accountId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!cat) {
        return res.status(400).json({ error: "Invalid categoryId for this account" });
      }
      categoryIdFilter = categoryIdRaw;
    }

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

    const transactions = await prisma.transaction.findMany({
      where: {
        accountId,
        deletedAt: null,
        ...(categoryIdFilter ? { categoryId: categoryIdFilter } : {}),
        ...(walletIdFilter ? { walletId: walletIdFilter } : {}),
        ...(from || to
          ? {
              occurredAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      },
      select: {
        id: true,
        type: true,
        amountMinor: true,
        currency: true,
        occurredAt: true,
        note: true,
        categoryId: true,
        walletId: true,
        instrumentId: true,
        investmentQuantity: true,
        transferGroupId: true,
        transferPairId: true,
        revokedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take,
    });

    return res.json({ transactions });
  } catch (err) {
    next(err);
  }
});

transactionsRouter.get("/:transactionId", async (req, res, next) => {
  try {
    const { accountId, transactionId } = req.params;

    const row = await prisma.transaction.findFirst({
      where: {
        id: transactionId,
        accountId,
        deletedAt: null,
      },
      select: {
        id: true,
        type: true,
        amountMinor: true,
        currency: true,
        occurredAt: true,
        note: true,
        categoryId: true,
        instrumentId: true,
        investmentQuantity: true,
        walletId: true,
        transferGroupId: true,
        transferPairId: true,
        revokedAt: true,
        createdAt: true,
        updatedAt: true,
        category: {
          select: {
            id: true,
            type: true,
            name: true,
            icon: true,
            color: true,
            internalKey: true,
          },
        },
        instrument: {
          select: {
            id: true,
            provider: true,
            providerSymbol: true,
            name: true,
            type: true,
            currency: true,
            exchange: true,
            country: true,
          },
        },
      },
    });

    if (!row) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    const accRow = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { investingEnabled: true },
    });

    let holdingContext = null;
    if (row.type === "INVESTMENT" && row.instrumentId) {
      const holding = await prisma.holding.findFirst({
        where: {
          accountId,
          instrumentId: row.instrumentId,
          deletedAt: null,
        },
        select: {
          id: true,
          quantity: true,
          costBasisMinor: true,
        },
      });

      const latestQuote = await prisma.quoteCache.findFirst({
        where: { instrumentId: row.instrumentId },
        orderBy: { asOf: "desc" },
        select: { price: true, currency: true, asOf: true },
      });

      const qty = holding ? Number(holding.quantity) : 0;
      const marketValueMinor =
        holding && latestQuote?.price
          ? Math.round(qty * Number(latestQuote.price) * 100)
          : null;

      holdingContext = {
        holdingId: holding?.id ?? null,
        quantity: holding?.quantity != null ? String(holding.quantity) : null,
        costBasisMinor: holding?.costBasisMinor ?? null,
        latestQuote: latestQuote
          ? {
              price: String(latestQuote.price),
              currency: latestQuote.currency,
              asOf: latestQuote.asOf.toISOString(),
            }
          : null,
        marketValueMinor,
        unrealizedPnLMinor:
          marketValueMinor != null && holding
            ? marketValueMinor - holding.costBasisMinor
            : null,
      };
    }

    return res.json({
      accountInvestingEnabled: accRow?.investingEnabled ?? false,
      transaction: {
        id: row.id,
        type: row.type,
        amountMinor: row.amountMinor,
        currency: row.currency,
        occurredAt: row.occurredAt.toISOString(),
        note: row.note,
        categoryId: row.categoryId,
        walletId: row.walletId,
        transferGroupId: row.transferGroupId,
        transferPairId: row.transferPairId,
        instrumentId: row.instrumentId,
        investmentQuantity:
          row.investmentQuantity != null
            ? String(row.investmentQuantity)
            : null,
        revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        category: row.category,
        instrument: row.instrument,
        holdingContext,
      },
    });
  } catch (err) {
    next(err);
  }
});

transactionsRouter.post("/", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const userId = req.auth.userId;

    const body = createTransactionSchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true, currency: true, walletsEnabled: true },
    });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    let walletId = body.walletId ?? null;
    if (account.walletsEnabled) {
      if (!walletId) {
        return res.status(400).json({ error: "walletId is required when wallets are enabled" });
      }
      const w = await prisma.accountWallet.findFirst({
        where: { id: walletId, accountId, deletedAt: null },
        select: { id: true },
      });
      if (!w) return res.status(400).json({ error: "Invalid walletId for this account" });
    } else if (walletId) {
      return res.status(400).json({ error: "walletId is only allowed when wallets are enabled" });
    }

    // Enforce single currency per account
    const currency = body.currency ?? account.currency;
    if (currency !== account.currency) {
      return res.status(400).json({
        error: "Transaction currency must match account currency",
      });
    }

    const category = await prisma.category.findFirst({
      where: {
        id: body.categoryId,
        accountId,
        deletedAt: null,
      },
      select: { id: true, type: true, internalKey: true },
    });

    if (!category) {
      return res.status(400).json({ error: "Invalid categoryId for account" });
    }

    if (category.internalKey) {
      return res.status(400).json({
        error: "This category cannot be selected for manual entries",
      });
    }

    if (category.type !== body.type) {
      return res.status(400).json({
        error: "Category type must match transaction type",
      });
    }

    const occurredAt = body.occurredAt ?? new Date();

    const tx = await prisma.transaction.create({
      data: {
        accountId,
        type: body.type,
        amountMinor: body.amountMinor,
        currency,
        occurredAt,
        note: body.note ?? null,
        categoryId: body.categoryId,
        createdByUserId: userId,
        walletId,
      },
      select: {
        id: true,
        type: true,
        amountMinor: true,
        currency: true,
        occurredAt: true,
        note: true,
        categoryId: true,
        walletId: true,
        revokedAt: true,
        createdAt: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        userId,
        action: "CREATE",
        entity: "Transaction",
        entityId: tx.id,
        meta: {
          accountId,
          type: tx.type,
          amountMinor: tx.amountMinor,
          currency: tx.currency,
        },
      },
    });

    return res.status(201).json({ transaction: tx });
  } catch (err) {
    next(err);
  }
});

transactionsRouter.post("/:transactionId/revoke", async (req, res, next) => {
  try {
    const { accountId, transactionId } = req.params;
    const userId = req.auth.userId;

    const existing = await prisma.transaction.findFirst({
      where: {
        id: transactionId,
        accountId,
        deletedAt: null,
      },
      select: {
        id: true,
        revokedAt: true,
        type: true,
        instrumentId: true,
        amountMinor: true,
        investmentQuantity: true,
        transferGroupId: true,
        transferPairId: true,
      },
    });

    if (!existing) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    if (existing.revokedAt) {
      return res.status(400).json({ error: "Transaction is already revoked" });
    }

    const updated = await prisma.$transaction(async (tx) => {
      const now = new Date();

      if (existing.transferPairId) {
        await tx.transaction.updateMany({
          where: {
            accountId,
            transferPairId: existing.transferPairId,
            deletedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        return tx.transaction.findFirst({
          where: { id: transactionId },
          select: {
            id: true,
            type: true,
            amountMinor: true,
            currency: true,
            occurredAt: true,
            note: true,
            categoryId: true,
            instrumentId: true,
            investmentQuantity: true,
            revokedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        });
      }

      if (existing.transferGroupId) {
        const transferGroup = await tx.transferGroup.findFirst({
          where: {
            id: existing.transferGroupId,
            deletedAt: null,
            OR: [{ fromAccountId: accountId }, { toAccountId: accountId }],
          },
          select: { fromAccountId: true, toAccountId: true },
        });
        if (!transferGroup) {
          const err = new Error("TRANSFER_GROUP_NOT_FOUND");
          err.statusCode = 404;
          throw err;
        }

        const otherAccountId =
          transferGroup.fromAccountId === accountId
            ? transferGroup.toAccountId
            : transferGroup.fromAccountId;
        const otherMember = await tx.accountMember.findFirst({
          where: {
            userId,
            accountId: otherAccountId,
            account: { deletedAt: null },
          },
          select: { role: true },
        });
        if (!otherMember) {
          const err = new Error("TRANSFER_REVOKE_REQUIRES_BOTH_ACCOUNTS");
          err.statusCode = 403;
          throw err;
        }

        await tx.transaction.updateMany({
          where: {
            transferGroupId: existing.transferGroupId,
            deletedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: now },
        });
        return tx.transaction.findFirst({
          where: { id: transactionId },
          select: {
            id: true,
            type: true,
            amountMinor: true,
            currency: true,
            occurredAt: true,
            note: true,
            categoryId: true,
            instrumentId: true,
            investmentQuantity: true,
            revokedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        });
      }

      if (
        existing.type === "INVESTMENT" &&
        existing.instrumentId &&
        existing.amountMinor > 0
      ) {
        const h = await tx.holding.findFirst({
          where: {
            accountId,
            instrumentId: existing.instrumentId,
            deletedAt: null,
          },
        });

        if (h) {
          const qtyHeld = Number(h.quantity);
          const costHeld = h.costBasisMinor;
          let qtyDec =
            existing.investmentQuantity != null
              ? Number(existing.investmentQuantity)
              : costHeld > 0
                ? qtyHeld * (existing.amountMinor / costHeld)
                : 0;

          if (!Number.isFinite(qtyDec) || qtyDec < 0) qtyDec = 0;
          if (qtyDec > qtyHeld) qtyDec = qtyHeld;

          const costDec = Math.min(existing.amountMinor, costHeld);
          const newCost = Math.max(0, costHeld - costDec);
          const newQty = Math.max(0, qtyHeld - qtyDec);

          if (newQty < 1e-12 || newCost <= 0) {
            await tx.holding.update({
              where: { id: h.id },
              data: {
                deletedAt: new Date(),
                quantity: 0,
                costBasisMinor: 0,
              },
            });
          } else {
            await tx.holding.update({
              where: { id: h.id },
              data: {
                quantity: newQty,
                costBasisMinor: newCost,
              },
            });
          }
        }
      }

      return tx.transaction.update({
        where: { id: transactionId },
        data: { revokedAt: now },
        select: {
          id: true,
          type: true,
          amountMinor: true,
          currency: true,
          occurredAt: true,
          note: true,
          categoryId: true,
          instrumentId: true,
          investmentQuantity: true,
          revokedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    await prisma.auditLog.create({
      data: {
        userId,
        action: "UPDATE",
        entity: "Transaction",
        entityId: transactionId,
        meta: { accountId, action: "REVOKE" },
      },
    });

    return res.json({
      transaction: {
        ...updated,
        investmentQuantity:
          updated.investmentQuantity != null
            ? String(updated.investmentQuantity)
            : null,
      },
    });
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    next(err);
  }
});

transactionsRouter.delete("/:transactionId", async (req, res, next) => {
  try {
    const { accountId, transactionId } = req.params;
    const userId = req.auth.userId;

    const existing = await prisma.transaction.findFirst({
      where: {
        id: transactionId,
        accountId,
        deletedAt: null,
      },
      select: { id: true, revokedAt: true },
    });

    if (!existing) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    if (!existing.revokedAt) {
      return res.status(400).json({
        error: "Revoke this transaction before deleting it permanently",
      });
    }

    await prisma.transaction.delete({
      where: { id: transactionId },
    });

    await prisma.auditLog.create({
      data: {
        userId,
        action: "DELETE",
        entity: "Transaction",
        entityId: transactionId,
        meta: { accountId, hardDelete: true },
      },
    });

    return res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = { transactionsRouter };

