const { Router } = require("express");
const { z } = require("zod");

const { prisma } = require("../prisma");
const {
  throwIfExpenseWouldCauseNegativeCashBalance,
} = require("../services/nonNegativeCashBalance");
const { assertCategoryManualMemberAccess } = require("../services/categoryMemberAccess");
const { ymdToZonedNoonUtc } = require("../lib/timezone");
const { isInvestmentCashOut } = require("../lib/investmentTransactions");

/**
 * @param {string} accountId
 * @param {Array<object & { transferGroupId?: string | null }>} rows
 */
async function attachTransferPeerAccountNames(accountId, rows) {
  if (!rows?.length) return rows;
  const groupIds = [...new Set(rows.map((r) => r.transferGroupId).filter(Boolean))];
  if (groupIds.length === 0) return rows;

  const groups = await prisma.transferGroup.findMany({
    where: { id: { in: groupIds } },
    select: {
      id: true,
      fromAccountId: true,
      toAccountId: true,
    },
  });
  const byGroupId = new Map(groups.map((g) => [g.id, g]));

  const peerIds = [
    ...new Set(
      groups.map((g) => (accountId === g.fromAccountId ? g.toAccountId : g.fromAccountId))
    ),
  ];

  const peerRows =
    peerIds.length === 0
      ? []
      : await prisma.account.findMany({
          where: { id: { in: peerIds } },
          select: { id: true, name: true },
        });
  const nameByPeerId = new Map(peerRows.map((a) => [a.id, a.name]));

  return rows.map((t) => {
    if (!t.transferGroupId || !byGroupId.has(t.transferGroupId)) return t;
    const g = byGroupId.get(t.transferGroupId);
    const peerAccountId =
      accountId === g.fromAccountId ? g.toAccountId : g.fromAccountId;
    const peerName = nameByPeerId.get(peerAccountId)?.trim();
    return {
      ...t,
      transferPeerAccountName: peerName || null,
    };
  });
}

const { requireAuth } = require("../middleware/auth");
const { requireAccountMember } = require("../middleware/requireAccountMember");

// Mounted at /accounts/:accountId/transactions
const transactionsRouter = Router({ mergeParams: true });

const createTransactionSchema = z.object({
  type: z.enum(["INCOME", "EXPENSE"]),
  amountMinor: z.number().int().positive(),
  currency: z.string().min(1).max(10).optional(),
  occurredAt: z.coerce.date().optional(),
  /** Calendar date ("YYYY-MM-DD") for back-dated entries; anchored to noon in the account timezone. */
  occurredOnDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "occurredOnDate must be YYYY-MM-DD")
    .optional(),
  note: z.string().max(500).optional(),
  categoryId: z.string().min(1),
  walletId: z.string().min(1).optional(),
});

const assignWalletsBulkSchema = z.object({
  assignments: z
    .array(
      z.object({
        transactionId: z.string().min(1),
        walletId: z.string().min(1),
      })
    )
    .min(1)
    .max(400),
});

transactionsRouter.use(requireAuth);
transactionsRouter.use(requireAccountMember("accountId"));

transactionsRouter.get("/", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const unassignedRaw = req.query.unassigned;
    const unassignedOnly =
      unassignedRaw === "1" || unassignedRaw === "true" || unassignedRaw === "yes";

    const walletReassignRaw = req.query.walletReassign;
    const walletReassign =
      walletReassignRaw === "1" || walletReassignRaw === "true" || walletReassignRaw === "yes";

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { walletsEnabled: true, walletMigrationPending: true },
    });
    if (!account) return res.status(404).json({ error: "Account not found" });

    if (unassignedOnly && walletReassign) {
      return res.status(400).json({ error: "Cannot combine walletReassign and unassigned filters" });
    }

    if (unassignedOnly && !account.walletsEnabled && !account.walletMigrationPending) {
      return res.status(400).json({ error: "unassigned filter requires wallets to be enabled" });
    }

    if (walletReassign && !account.walletsEnabled && !account.walletMigrationPending) {
      return res.status(400).json({ error: "walletReassign requires wallets to be enabled" });
    }

    const pagedList = unassignedOnly || walletReassign;
    const maxTake = pagedList ? 100 : 200;
    const take = Math.min(
      maxTake,
      Math.max(1, Number.parseInt(req.query.limit, 10) || (pagedList ? 100 : 100))
    );

    const offsetRaw = Number.parseInt(req.query.offset, 10);
    const offset =
      pagedList && Number.isFinite(offsetRaw) && offsetRaw >= 0
        ? Math.min(offsetRaw, 10_000_000)
        : 0;

    const walletIdRaw =
      typeof req.query.walletId === "string" && req.query.walletId.trim()
        ? req.query.walletId.trim()
        : undefined;

    if (unassignedOnly && walletIdRaw) {
      return res.status(400).json({ error: "Cannot combine unassigned and walletId filters" });
    }

    if (walletReassign && walletIdRaw) {
      return res.status(400).json({ error: "Cannot combine walletReassign and walletId filters" });
    }

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

    const where = {
      accountId,
      deletedAt: null,
      ...(unassignedOnly ? { walletId: null, revokedAt: null } : {}),
      ...(walletReassign ? { revokedAt: null } : {}),
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
    };

    let total = undefined;
    if (pagedList) {
      total = await prisma.transaction.count({ where });
    }

    let transactions = await prisma.transaction.findMany({
      where,
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
        scheduleOriginKind: true,
      },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take,
      ...(pagedList ? { skip: offset } : {}),
    });

    transactions = await attachTransferPeerAccountNames(accountId, transactions);

    const hasMore = pagedList ? offset + transactions.length < total : false;

    if (pagedList) {
      return res.json({
        transactions,
        total,
        offset,
        limit: take,
        hasMore,
      });
    }

    return res.json({ transactions });
  } catch (err) {
    next(err);
  }
});

transactionsRouter.post("/assign-wallets", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const userId = req.auth.userId;
    const body = assignWalletsBulkSchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true, walletsEnabled: true, walletMigrationPending: true },
    });
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (!account.walletsEnabled && !account.walletMigrationPending) {
      return res.status(400).json({ error: "Wallets are not enabled for this account" });
    }

    const walletRows = await prisma.accountWallet.findMany({
      where: { accountId, deletedAt: null },
      select: { id: true },
    });
    const walletSet = new Set(walletRows.map((w) => w.id));

    const txIds = [...new Set(body.assignments.map((a) => a.transactionId))];
    const rows = await prisma.transaction.findMany({
      where: {
        id: { in: txIds },
        accountId,
        deletedAt: null,
        revokedAt: null,
      },
      select: { id: true },
    });
    if (rows.length !== txIds.length) {
      return res.status(400).json({ error: "One or more transactions were not found or are not assignable" });
    }

    for (const a of body.assignments) {
      if (!walletSet.has(a.walletId)) {
        return res.status(400).json({ error: "Invalid walletId in assignments" });
      }
    }

    await prisma.$transaction(
      body.assignments.map((a) =>
        prisma.transaction.update({
          where: { id: a.transactionId },
          data: { walletId: a.walletId },
        })
      )
    );

    await prisma.auditLog.create({
      data: {
        userId,
        action: "UPDATE",
        entity: "Transaction",
        entityId: accountId,
        meta: { accountId, action: "BULK_ASSIGN_WALLETS", count: body.assignments.length },
      },
    });

    return res.json({ updated: body.assignments.length });
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
        scheduleOriginKind: true,
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

    const [txRow] = await attachTransferPeerAccountNames(accountId, [row]);

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
        scheduleOriginKind: row.scheduleOriginKind ?? null,
        transferPeerAccountName: txRow.transferPeerAccountName ?? null,
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
      select: {
        id: true,
        currency: true,
        timezone: true,
        walletsEnabled: true,
        walletMigrationPending: true,
      },
    });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    let walletId = body.walletId ?? null;
    const walletsLive = account.walletsEnabled || account.walletMigrationPending;
    if (walletsLive) {
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
      select: {
        id: true,
        type: true,
        internalKey: true,
        lockedForManualEntry: true,
        memberAccessRestricted: true,
      },
    });

    if (!category) {
      return res.status(400).json({ error: "Invalid categoryId for account" });
    }

    try {
      await assertCategoryManualMemberAccess(prisma, { accountId, userId, category });
    } catch (e) {
      if (e && e.statusCode === 403) {
        return res.status(403).json({ error: "You do not have access to this category" });
      }
      if (e && e.statusCode === 400) {
        if (e.message === "MANUAL_LOCKED") {
          return res.status(400).json({
            error: "This category is locked and cannot be selected for manual entries",
          });
        }
        if (e.message === "SYS_CATEGORY") {
          return res.status(400).json({
            error: "This category is locked and cannot be selected for manual entries",
          });
        }
      }
      throw e;
    }

    if (category.type !== body.type) {
      return res.status(400).json({
        error: "Category type must match transaction type",
      });
    }

    // Priority: explicit instant (occurredAt) > back-dated calendar date (noon in
    // account timezone) > server "now".
    let occurredAt = body.occurredAt ?? null;
    if (!occurredAt && body.occurredOnDate) {
      occurredAt = ymdToZonedNoonUtc(body.occurredOnDate, account.timezone);
      if (!occurredAt) {
        return res.status(400).json({ error: "Invalid occurredOnDate" });
      }
    }
    if (!occurredAt) occurredAt = new Date();

    if (body.type === "EXPENSE") {
      try {
        await throwIfExpenseWouldCauseNegativeCashBalance(
          prisma,
          accountId,
          body.amountMinor,
          walletId
        );
      } catch (e) {
        if (e && e.code === "NEGATIVE_CASH_BALANCE") {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    }

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
        category: {
          select: { internalKey: true },
        },
      },
    });

    if (!existing) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    if (existing.revokedAt) {
      return res.status(400).json({ error: "Transaction is already revoked" });
    }

    if (isInvestmentCashOut(existing)) {
      return res.status(409).json({
        code: "cash_out_revoke_not_supported",
        error:
          "Cash-out transactions cannot be revoked because doing so would corrupt the investment holding.",
      });
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

