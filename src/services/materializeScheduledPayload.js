const {
  throwIfExpenseWouldCauseNegativeCashBalance,
} = require("./nonNegativeCashBalance");
const { assertCategoryManualMemberAccess } = require("./categoryMemberAccess");
const { lockAccountInvestingForUpdate } = require("../lib/lockAccountInvesting");

/**
 * Creates a ledger row from a stored schedule payload (same rules as manual POST routes).
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {{ accountId: string; userId: string; occurredAt: Date; payload: Record<string, unknown>; scheduleKind?: 'DELAY_ONCE' | 'RECURRING' }} args
 */
async function materializeScheduledPayload(tx, { accountId, userId, occurredAt, payload, scheduleKind }) {
  const tab = payload.tab;
  const amountMinor = Number(payload.amountMinor);
  const categoryId = typeof payload.categoryId === "string" ? payload.categoryId : null;
  const note = typeof payload.note === "string" ? payload.note.slice(0, 500) : null;
  const walletId = typeof payload.walletId === "string" ? payload.walletId : null;

  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    throw new Error("INVALID_AMOUNT");
  }
  if (!categoryId) {
    throw new Error("MISSING_CATEGORY");
  }

  const account = await tx.account.findFirst({
    where: { id: accountId, deletedAt: null },
    select: { id: true, currency: true, investingEnabled: true, walletsEnabled: true },
  });
  if (!account) throw new Error("NO_ACCOUNT");

  if (account.walletsEnabled) {
    if (!walletId) throw new Error("WALLET_REQUIRED");
    const w = await tx.accountWallet.findFirst({
      where: { id: walletId, accountId, deletedAt: null },
      select: { id: true },
    });
    if (!w) throw new Error("BAD_WALLET");
  } else if (walletId) {
    throw new Error("WALLET_NOT_ALLOWED");
  }

  if (tab === "income" || tab === "expense") {
    const type = tab === "income" ? "INCOME" : "EXPENSE";
    const category = await tx.category.findFirst({
      where: { id: categoryId, accountId, deletedAt: null },
      select: {
        id: true,
        type: true,
        internalKey: true,
        lockedForManualEntry: true,
        memberAccessRestricted: true,
      },
    });
    if (!category || category.lockedForManualEntry || category.internalKey) throw new Error("BAD_CATEGORY");
    if (category.type !== type) throw new Error("CATEGORY_TYPE_MISMATCH");

    await assertCategoryManualMemberAccess(tx, { accountId, userId, category });

    if (type === "EXPENSE") {
      await throwIfExpenseWouldCauseNegativeCashBalance(
        tx,
        accountId,
        amountMinor,
        walletId
      );
    }

    const row = await tx.transaction.create({
      data: {
        accountId,
        type,
        amountMinor,
        currency: account.currency,
        occurredAt,
        note,
        categoryId,
        createdByUserId: userId,
        walletId: walletId || null,
        ...(scheduleKind ? { scheduleOriginKind: scheduleKind } : {}),
      },
    });
    await tx.auditLog.create({
      data: {
        userId,
        action: "CREATE",
        entity: "Transaction",
        entityId: row.id,
        meta: { accountId, scheduled: true, type },
      },
    });
    return { kind: "TRANSACTION", id: row.id };
  }

  if (tab === "invest") {
    // Lock before buy so investing disable cannot pass its holdings check while
    // this materialization still opens a holding afterward.
    const locked = await lockAccountInvestingForUpdate(tx, accountId);
    if (!locked) throw new Error("NO_ACCOUNT");
    if (!locked.investingEnabled) throw new Error("INVESTING_OFF");

    const instrumentId = typeof payload.instrumentId === "string" ? payload.instrumentId : null;
    const quantity = Number(payload.quantity);
    if (!instrumentId || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("BAD_INVEST_FIELDS");
    }

    const instrument = await tx.instrument.findFirst({
      where: { id: instrumentId, isActive: true },
      select: { id: true, name: true, providerSymbol: true },
    });
    if (!instrument) throw new Error("BAD_INSTRUMENT");

    const category = await tx.category.findFirst({
      where: { id: categoryId, accountId, type: "INVESTMENT", deletedAt: null },
      select: {
        id: true,
        type: true,
        internalKey: true,
        lockedForManualEntry: true,
        memberAccessRestricted: true,
      },
    });
    if (!category) throw new Error("BAD_INV_CATEGORY");
    if (category.lockedForManualEntry) throw new Error("BAD_INV_CATEGORY");

    await assertCategoryManualMemberAccess(tx, { accountId, userId, category });

    const txRow = await tx.transaction.create({
      data: {
        accountId,
        type: "INVESTMENT",
        amountMinor,
        currency: locked.currency,
        occurredAt,
        note,
        categoryId: category.id,
        createdByUserId: userId,
        instrumentId: instrument.id,
        investmentQuantity: quantity,
        walletId: walletId || null,
        ...(scheduleKind ? { scheduleOriginKind: scheduleKind } : {}),
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
        quantity: { increment: quantity },
        costBasisMinor: { increment: amountMinor },
      },
      create: {
        accountId,
        instrumentId: instrument.id,
        categoryId: category.id,
        quantity,
        costBasisMinor: amountMinor,
        note: note ?? null,
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
          scheduled: true,
          instrumentId: instrument.id,
          amountMinor,
        },
      },
    });

    return { kind: "INVESTMENT", id: txRow.id, holdingId: holding.id };
  }

  throw new Error("UNKNOWN_TAB");
}

module.exports = { materializeScheduledPayload };
