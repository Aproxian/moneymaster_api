const { Router } = require("express");
const { z } = require("zod");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");

const transfersRouter = Router();

const createTransferSchema = z.object({
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1),
  fromCategoryId: z.string().min(1),
  toCategoryId: z.string().min(1),
  // amount in minor units (e.g. cents)
  amountMinor: z.number().int().positive(),
  // optional, required when currencies differ
  fxRate: z.number().positive().optional(),
  occurredAt: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
  fromWalletId: z.string().min(1).optional(),
  toWalletId: z.string().min(1).optional(),
});

transfersRouter.use(requireAuth);

transfersRouter.post("/", async (req, res, next) => {
  try {
    const body = createTransferSchema.parse(req.body);
    const userId = req.auth.userId;

    if (body.fromAccountId === body.toAccountId) {
      return res
        .status(400)
        .json({ error: "fromAccountId and toAccountId must be different" });
    }

    const [fromAccount, toAccount] = await Promise.all([
      prisma.account.findFirst({
        where: { id: body.fromAccountId, deletedAt: null },
        select: {
          id: true,
          currency: true,
          walletsEnabled: true,
          walletMigrationPending: true,
        },
      }),
      prisma.account.findFirst({
        where: { id: body.toAccountId, deletedAt: null },
        select: {
          id: true,
          currency: true,
          walletsEnabled: true,
          walletMigrationPending: true,
        },
      }),
    ]);

    if (!fromAccount || !toAccount) {
      return res.status(404).json({ error: "Account not found" });
    }

    const [fromMember, toMember] = await Promise.all([
      prisma.accountMember.findUnique({
        where: {
          userId_accountId: {
            userId,
            accountId: fromAccount.id,
          },
        },
        select: { role: true },
      }),
      prisma.accountMember.findUnique({
        where: {
          userId_accountId: {
            userId,
            accountId: toAccount.id,
          },
        },
        select: { role: true },
      }),
    ]);

    if (!fromMember || !toMember) {
      return res
        .status(403)
        .json({ error: "User must be a member of both accounts" });
    }

    const sameCurrency = fromAccount.currency === toAccount.currency;
    let fxRate = body.fxRate ?? null;

    if (!sameCurrency && !fxRate) {
      return res
        .status(400)
        .json({ error: "fxRate is required when currencies differ" });
    }

    if (sameCurrency) {
      fxRate = null;
    }

    const occurredAt = body.occurredAt ?? new Date();

    const [fromCategory, toCategory] = await Promise.all([
      prisma.category.findFirst({
        where: {
          id: body.fromCategoryId,
          accountId: fromAccount.id,
          type: "EXPENSE",
          deletedAt: null,
        },
        select: { id: true },
      }),
      prisma.category.findFirst({
        where: {
          id: body.toCategoryId,
          accountId: toAccount.id,
          type: "INCOME",
          deletedAt: null,
        },
        select: { id: true },
      }),
    ]);

    if (!fromCategory) {
      return res.status(400).json({
        error: "Invalid fromCategoryId (must be an EXPENSE category for fromAccount)",
      });
    }

    if (!toCategory) {
      return res.status(400).json({
        error: "Invalid toCategoryId (must be an INCOME category for toAccount)",
      });
    }

    const fromWalletsLive =
      fromAccount.walletsEnabled || fromAccount.walletMigrationPending;
    if (fromWalletsLive) {
      if (!body.fromWalletId) {
        return res.status(400).json({ error: "fromWalletId is required when the source account uses wallets" });
      }
      const w = await prisma.accountWallet.findFirst({
        where: { id: body.fromWalletId, accountId: fromAccount.id, deletedAt: null },
        select: { id: true },
      });
      if (!w) return res.status(400).json({ error: "Invalid fromWalletId" });
    } else if (body.fromWalletId) {
      return res.status(400).json({ error: "fromWalletId requires wallets on the source account" });
    }

    const toWalletsLive =
      toAccount.walletsEnabled || toAccount.walletMigrationPending;
    if (toWalletsLive) {
      if (!body.toWalletId) {
        return res.status(400).json({ error: "toWalletId is required when the destination account uses wallets" });
      }
      const w = await prisma.accountWallet.findFirst({
        where: { id: body.toWalletId, accountId: toAccount.id, deletedAt: null },
        select: { id: true },
      });
      if (!w) return res.status(400).json({ error: "Invalid toWalletId" });
    } else if (body.toWalletId) {
      return res.status(400).json({ error: "toWalletId requires wallets on the destination account" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const toAmountMinor = sameCurrency
        ? body.amountMinor
        : Math.round(body.amountMinor * fxRate);

      const transferGroup = await tx.transferGroup.create({
        data: {
          initiatedById: userId,
          fromAccountId: fromAccount.id,
          toAccountId: toAccount.id,
          fxRate,
          note: body.note ?? null,
        },
      });

      const fromTx = await tx.transaction.create({
        data: {
          accountId: fromAccount.id,
          type: "EXPENSE",
          amountMinor: body.amountMinor,
          currency: fromAccount.currency,
          occurredAt,
          note: body.note ?? null,
          categoryId: fromCategory.id,
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
          note: body.note ?? null,
          categoryId: toCategory.id,
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
            fromCurrency: fromAccount.currency,
            toCurrency: toAccount.currency,
            amountMinorFrom: body.amountMinor,
            amountMinorTo: toAmountMinor,
            fxRate,
          },
        },
      });

      return {
        transferGroup,
        fromTransaction: fromTx,
        toTransaction: toTx,
      };
    });

    return res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = { transfersRouter };

