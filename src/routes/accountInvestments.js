const { Router } = require("express");
const { z } = require("zod");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const { requireAccountMember } = require("../middleware/requireAccountMember");
const { assertCategoryManualMemberAccess } = require("../services/categoryMemberAccess");
const { ymdToZonedNoonUtc } = require("../lib/timezone");
const {
  AccountCurrencyChangedError,
  assertAccountCurrencyLocked,
} = require("../lib/lockAccountCurrency");

// Mounted at /accounts/:accountId/investments
const accountInvestmentsRouter = Router({ mergeParams: true });

const createInvestmentSchema = z.object({
  instrumentId: z.string().min(1),
  categoryId: z.string().min(1),
  amountMinor: z.number().int().positive(),
  quantity: z.number().positive(),
  occurredAt: z.coerce.date().optional(),
  occurredOnDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "occurredOnDate must be YYYY-MM-DD")
    .optional(),
  note: z.string().max(500).optional(),
  walletId: z.string().min(1).optional(),
});

accountInvestmentsRouter.use(requireAuth);
accountInvestmentsRouter.use(requireAccountMember("accountId"));

accountInvestmentsRouter.post("/", async (req, res, next) => {
  try {
    const { accountId } = req.params;
    const userId = req.auth.userId;

    const body = createInvestmentSchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: {
        id: true,
        currency: true,
        timezone: true,
        investingEnabled: true,
        walletsEnabled: true,
      },
    });

    if (!account) {
      return res.status(404).json({ error: "Account not found" });
    }

    if (!account.investingEnabled) {
      return res.status(403).json({ error: "Investing is disabled for this account" });
    }

    const instrument = await prisma.instrument.findFirst({
      where: {
        id: body.instrumentId,
        isActive: true,
      },
      select: {
        id: true,
        currency: true,
        name: true,
        providerSymbol: true,
      },
    });

    if (!instrument) {
      return res.status(400).json({ error: "Invalid instrumentId" });
    }

    const category = await prisma.category.findFirst({
      where: {
        id: body.categoryId,
        accountId,
        type: "INVESTMENT",
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
      return res.status(400).json({
        error: "Invalid categoryId (must be an INVESTMENT category for account)",
      });
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
            error: "This category is locked and cannot be used for manual investments",
          });
        }
      }
      throw e;
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

    // For now we assume instrument prices and account currency match,
    // so no FX is applied at this layer.
    let occurredAt = body.occurredAt ?? null;
    if (!occurredAt && body.occurredOnDate) {
      occurredAt = ymdToZonedNoonUtc(body.occurredOnDate, account.timezone);
      if (!occurredAt) {
        return res.status(400).json({ error: "Invalid occurredOnDate" });
      }
    }
    if (!occurredAt) occurredAt = new Date();

    const result = await prisma.$transaction(async (tx) => {
      // amountMinor is in the pre-read account currency; fail closed if FX
      // conversion flipped Account.currency before we insert.
      await assertAccountCurrencyLocked(tx, accountId, account.currency);

      const txRow = await tx.transaction.create({
        data: {
          accountId,
          type: "INVESTMENT",
          amountMinor: body.amountMinor,
          currency: account.currency,
          occurredAt,
          note: body.note ?? null,
          categoryId: category.id,
          createdByUserId: userId,
          instrumentId: instrument.id,
          investmentQuantity: body.quantity,
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
          instrumentId: true,
          investmentQuantity: true,
          createdAt: true,
        },
      });

      const holding = await tx.holding.upsert({
        where: {
          accountId_instrumentId: {
            accountId,
            instrumentId: instrument.id,
          },
        },
        update: {
          categoryId: category.id,
          quantity: {
            increment: body.quantity,
          },
          costBasisMinor: {
            increment: body.amountMinor,
          },
          // Clear soft-delete when re-buying an instrument that was previously fully cashed out.
          deletedAt: null,
        },
        create: {
          accountId,
          instrumentId: instrument.id,
          categoryId: category.id,
          quantity: body.quantity,
          costBasisMinor: body.amountMinor,
          note: body.note ?? null,
        },
        select: {
          id: true,
          accountId: true,
          instrumentId: true,
          categoryId: true,
          quantity: true,
        },
      });

      await tx.auditLog.create({
        data: {
          userId,
          action: "CREATE",
          entity: "Investment",
          entityId: txRow.id,
          meta: {
            accountId,
            instrumentId: instrument.id,
            instrumentName: instrument.name,
            providerSymbol: instrument.providerSymbol,
            amountMinor: txRow.amountMinor,
            categoryId: category.id,
            quantity: holding.quantity,
          },
        },
      });

      return { transaction: txRow, holding };
    });

    return res.status(201).json(result);
  } catch (err) {
    if (
      err instanceof AccountCurrencyChangedError ||
      err?.code === "account_currency_changed"
    ) {
      return res.status(409).json({
        code: "account_currency_changed",
        error: err.message,
      });
    }
    if (err?.statusCode === 404) {
      return res.status(404).json({ error: err.message || "Account not found" });
    }
    next(err);
  }
});

module.exports = { accountInvestmentsRouter };

