const { Router } = require("express");
const { z } = require("zod");

const { prisma } = require("../prisma");
const { requireAuth } = require("../middleware/auth");
const { requireAccountMember } = require("../middleware/requireAccountMember");
const { CASH_OUT_INVESTMENT } = require("../lib/investmentCategoryKeys");
const {
  lockOpenHoldingForUpdate,
  planCashOutHoldingUpdate,
} = require("../lib/lockHolding");
const { getPrimaryOwnerUserId } = require("../services/categoryMemberAccess");
const { ensureInvestmentCategories } = require("../services/investingCategories");

const accountInstrumentsRouter = Router({ mergeParams: true });

accountInstrumentsRouter.use(requireAuth);
accountInstrumentsRouter.use(requireAccountMember("accountId"));

const cashOutSchema = z.object({
  quantitySold: z.number().positive(),
  pricePerUnit: z.number().positive(),
  walletId: z.string().min(1).optional(),
});

/**
 * GET /accounts/:accountId/instruments/:instrumentId/summary
 */
accountInstrumentsRouter.get("/:instrumentId/summary", async (req, res, next) => {
  try {
    const { accountId, instrumentId } = req.params;

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true, investingEnabled: true, currency: true },
    });
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (!account.investingEnabled) {
      return res.status(403).json({ error: "Investing is disabled for this account" });
    }

    const instrument = await prisma.instrument.findFirst({
      where: { id: instrumentId, isActive: true },
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
    });
    if (!instrument) return res.status(404).json({ error: "Instrument not found" });

    const holding = await prisma.holding.findFirst({
      where: { accountId, instrumentId, deletedAt: null },
      select: {
        id: true,
        quantity: true,
        costBasisMinor: true,
        categoryId: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const txs = await prisma.transaction.findMany({
      where: {
        accountId,
        instrumentId,
        deletedAt: null,
      },
      select: {
        id: true,
        type: true,
        amountMinor: true,
        occurredAt: true,
        note: true,
        categoryId: true,
        investmentQuantity: true,
        revokedAt: true,
        category: { select: { name: true, internalKey: true } },
      },
      orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
      take: 80,
    });

    const quotes = await prisma.quoteCache.findMany({
      where: { instrumentId },
      orderBy: { asOf: "desc" },
      take: 30,
      select: {
        price: true,
        currency: true,
        asOf: true,
        provider: true,
      },
    });

    const latest = quotes[0] ?? null;
    const qty = holding ? Number(holding.quantity) : 0;
    const marketValueMinor =
      holding && latest?.price
        ? Math.round(qty * Number(latest.price) * 100)
        : null;

    const unrealizedPnLMinor =
      marketValueMinor != null && holding
        ? marketValueMinor - holding.costBasisMinor
        : null;

    const buys = txs.filter((t) => t.type === "INVESTMENT" && !t.revokedAt);
    const cashOuts = txs.filter(
      (t) =>
        t.type === "INCOME" &&
        !t.revokedAt &&
        t.category?.internalKey === CASH_OUT_INVESTMENT
    );

    const totalBuyMinor = buys.reduce((s, t) => s + t.amountMinor, 0);
    const totalCashOutMinor = cashOuts.reduce((s, t) => s + t.amountMinor, 0);

    return res.json({
      account: { id: account.id, currency: account.currency },
      instrument,
      holding,
      latestQuote: latest
        ? {
            price: String(latest.price),
            currency: latest.currency,
            asOf: latest.asOf.toISOString(),
            provider: latest.provider,
          }
        : null,
      metrics: {
        marketValueMinor,
        unrealizedPnLMinor,
        costBasisMinor: holding?.costBasisMinor ?? null,
        totalBuyMinor,
        totalCashOutProceedsMinor: totalCashOutMinor,
      },
      transactions: txs.map((t) => ({
        ...t,
        investmentQuantity:
          t.investmentQuantity != null ? String(t.investmentQuantity) : null,
        revokedAt: t.revokedAt ? t.revokedAt.toISOString() : null,
        occurredAt: t.occurredAt.toISOString(),
      })),
      quoteHistory: quotes.map((q) => ({
        price: String(q.price),
        currency: q.currency,
        asOf: q.asOf.toISOString(),
        provider: q.provider,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /accounts/:accountId/instruments/:instrumentId/cash-out
 */
accountInstrumentsRouter.post("/:instrumentId/cash-out", async (req, res, next) => {
  try {
    const { accountId, instrumentId } = req.params;
    const userId = req.auth.userId;
    const body = cashOutSchema.parse(req.body);

    const account = await prisma.account.findFirst({
      where: { id: accountId, deletedAt: null },
      select: { id: true, currency: true, investingEnabled: true, walletsEnabled: true },
    });
    if (!account) return res.status(404).json({ error: "Account not found" });
    if (!account.investingEnabled) {
      return res.status(403).json({ error: "Investing is disabled for this account" });
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

    const proceedsMinor = Math.round(body.quantitySold * body.pricePerUnit * 100);
    if (!Number.isFinite(proceedsMinor) || proceedsMinor <= 0) {
      return res.status(400).json({ error: "Invalid proceeds amount" });
    }

    const result = await prisma.$transaction(async (tx) => {
      // Serialize cash-outs on this holding so concurrent sells cannot both
      // pass the quantity check against the same pre-write balance.
      const holding = await lockOpenHoldingForUpdate(tx, {
        accountId,
        instrumentId,
      });
      if (!holding) {
        const err = new Error("NO_HOLDING");
        throw err;
      }

      const qtyHeld = Number(holding.quantity);
      const planned = planCashOutHoldingUpdate({
        quantityHeld: qtyHeld,
        costBasisMinor: holding.costBasisMinor,
        quantitySold: body.quantitySold,
      });

      let cat = await tx.category.findFirst({
        where: {
          accountId,
          internalKey: CASH_OUT_INVESTMENT,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!cat) {
        const ownerId = await getPrimaryOwnerUserId(tx, accountId);
        await ensureInvestmentCategories(tx, accountId, { createdByUserId: ownerId });
        cat = await tx.category.findFirst({
          where: {
            accountId,
            internalKey: CASH_OUT_INVESTMENT,
            deletedAt: null,
          },
          select: { id: true },
        });
      }
      if (!cat) {
        const err = new Error("NO_CATEGORY");
        throw err;
      }

      const { newCost, newQty, shouldClose } = planned;

      const income = await tx.transaction.create({
        data: {
          accountId,
          type: "INCOME",
          amountMinor: proceedsMinor,
          currency: account.currency,
          occurredAt: new Date(),
          note: `Cash out ${body.quantitySold} @ ${body.pricePerUnit}`,
          categoryId: cat.id,
          createdByUserId: userId,
          instrumentId,
          walletId,
          investmentQuantity: -body.quantitySold,
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
        },
      });

      if (shouldClose) {
        await tx.holding.update({
          where: { id: holding.id },
          data: {
            deletedAt: new Date(),
            quantity: 0,
            costBasisMinor: 0,
          },
        });
      } else {
        await tx.holding.update({
          where: { id: holding.id },
          data: {
            quantity: newQty,
            costBasisMinor: newCost,
          },
        });
      }

      await tx.auditLog.create({
        data: {
          userId,
          action: "CREATE",
          entity: "CashOutInvestment",
          entityId: income.id,
          meta: {
            accountId,
            instrumentId,
            quantitySold: body.quantitySold,
            pricePerUnit: body.pricePerUnit,
            proceedsMinor,
          },
        },
      });

      return { transaction: income };
    });

    return res.status(201).json(result);
  } catch (err) {
    if (err.message === "NO_HOLDING") {
      return res.status(400).json({ error: "No open holding for this instrument" });
    }
    if (err.message === "QTY_TOO_LARGE") {
      return res.status(400).json({ error: "Cannot sell more than you hold" });
    }
    if (err.message === "NO_CATEGORY") {
      return res.status(500).json({ error: "Could not resolve cash-out category" });
    }
    next(err);
  }
});

module.exports = { accountInstrumentsRouter };
