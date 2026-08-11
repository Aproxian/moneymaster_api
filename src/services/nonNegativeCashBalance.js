const { Prisma } = require("@prisma/client");

const { walletBalanceMinor } = require("./walletBalance");

/**
 * Serialize cash/wallet balance checks for an account (expense create, invest buy, revoke).
 * @param {import('@prisma/client').Prisma.TransactionClient | import('@prisma/client').PrismaClient} db
 * @param {string} accountId
 */
async function lockAccountForCashBalanceCheck(db, accountId) {
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM \`Account\` WHERE id = ${accountId} FOR UPDATE`
  );
}

function negativeCashBalanceError(message) {
  const err = new Error(message);
  err.code = "NEGATIVE_CASH_BALANCE";
  return err;
}

/**
 * Cash balance matches dashboard overview: sum(INCOME) − sum(EXPENSE), non-revoked rows only.
 * INVESTMENT rows are excluded from this metric.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient | import('@prisma/client').PrismaClient} db
 * @param {string} accountId
 */
async function getAccountCashBalanceMinor(db, accountId) {
  const grouped = await db.transaction.groupBy({
    by: ["type"],
    where: {
      accountId,
      deletedAt: null,
      revokedAt: null,
    },
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
  return incomeMinor - expenseMinor;
}

/**
 * @param {import('@prisma/client').Prisma.TransactionClient | import('@prisma/client').PrismaClient} db
 * @param {string} accountId
 */
async function loadCashLockAccount(db, accountId) {
  return db.account.findFirst({
    where: { id: accountId, deletedAt: null },
    select: {
      preventNegativeCashBalance: true,
      walletsEnabled: true,
      walletMigrationPending: true,
    },
  });
}

/**
 * Throws if an expense would push overall cash or (when targeted) a wallet pile below zero.
 * Mirrors real cash: book-level income−expense cannot go negative; with wallets, each wallet pile cannot either.
 * No-op when {@link Account.preventNegativeCashBalance} is false.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient | import('@prisma/client').PrismaClient} db
 * @param {string | null | undefined} walletId expense wallet when wallets are used
 */
async function throwIfExpenseWouldCauseNegativeCashBalance(
  db,
  accountId,
  expenseAmountMinor,
  walletId = null
) {
  const account = await loadCashLockAccount(db, accountId);
  if (!account?.preventNegativeCashBalance) return;

  await lockAccountForCashBalanceCheck(db, accountId);

  const bal = await getAccountCashBalanceMinor(db, accountId);
  if (bal - expenseAmountMinor < 0) {
    throw negativeCashBalanceError(
      "This account is set to prevent cash balance from going below zero"
    );
  }

  const walletsLive =
    account.walletsEnabled || account.walletMigrationPending;
  if (walletsLive && walletId) {
    const wBal = await walletBalanceMinor(db, walletId);
    if (wBal - expenseAmountMinor < 0) {
      throw negativeCashBalanceError(
        "Not enough balance in this wallet for this amount"
      );
    }
  }
}

/**
 * INVESTMENT buys debit wallet piles ({@link walletBalanceMinor}) but are excluded from
 * account overview cash. When the negative-cash lock is on and wallets are live, refuse a
 * buy that would push the source wallet below zero (same pile invariant as expenses).
 *
 * No-op when the lock is off, wallets are not live, or no wallet is targeted.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient | import('@prisma/client').PrismaClient} db
 * @param {string | null | undefined} walletId
 */
async function throwIfInvestmentWouldCauseNegativeWalletBalance(
  db,
  accountId,
  amountMinor,
  walletId = null
) {
  if (!walletId) return;

  const account = await loadCashLockAccount(db, accountId);
  if (!account?.preventNegativeCashBalance) return;

  const walletsLive =
    account.walletsEnabled || account.walletMigrationPending;
  if (!walletsLive) return;

  await lockAccountForCashBalanceCheck(db, accountId);

  const wBal = await walletBalanceMinor(db, walletId);
  if (wBal - amountMinor < 0) {
    throw negativeCashBalanceError(
      "Not enough balance in this wallet for this amount"
    );
  }
}

/**
 * Lock every account in `accountIds` that has the negative-cash lock enabled.
 * Call before mutations that can remove credits (e.g. revoke) so concurrent expense
 * writers serialize on the same Account row. Locks in sorted id order.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient | import('@prisma/client').PrismaClient} db
 * @param {string[]} accountIds
 */
async function lockAccountsForNegativeCashGuard(db, accountIds) {
  const sorted = [...new Set(accountIds.filter(Boolean))].sort();
  for (const accountId of sorted) {
    const account = await loadCashLockAccount(db, accountId);
    if (account?.preventNegativeCashBalance) {
      await lockAccountForCashBalanceCheck(db, accountId);
    }
  }
}

/**
 * After a revoke (or other mutation), ensure the lock still holds for this account:
 * book cash ≥ 0 and every open wallet pile ≥ 0.
 * No-op when {@link Account.preventNegativeCashBalance} is false.
 * Prefer {@link lockAccountsForNegativeCashGuard} before the mutation when racing writers matter.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient | import('@prisma/client').PrismaClient} db
 * @param {string} accountId
 */
async function throwIfCashBalancesAreNegative(db, accountId) {
  const account = await loadCashLockAccount(db, accountId);
  if (!account?.preventNegativeCashBalance) return;

  await lockAccountForCashBalanceCheck(db, accountId);

  const bal = await getAccountCashBalanceMinor(db, accountId);
  if (bal < 0) {
    throw negativeCashBalanceError(
      "This account is set to prevent cash balance from going below zero"
    );
  }

  const walletsLive =
    account.walletsEnabled || account.walletMigrationPending;
  if (!walletsLive) return;

  const wallets = await db.accountWallet.findMany({
    where: { accountId, deletedAt: null },
    select: { id: true },
  });
  for (const w of wallets) {
    const wBal = await walletBalanceMinor(db, w.id);
    if (wBal < 0) {
      throw negativeCashBalanceError(
        "Not enough balance in this wallet for this amount"
      );
    }
  }
}

/**
 * When turning on {@link Account.preventNegativeCashBalance}, the book and (if wallets are live)
 * every wallet must already be non-negative—otherwise the rule cannot be applied consistently.
 *
 * @param {import('@prisma/client').Prisma.TransactionClient | import('@prisma/client').PrismaClient} db
 * @param {string} accountId
 */
async function throwIfCannotEnablePreventNegativeCashBalance(db, accountId) {
  const account = await db.account.findFirst({
    where: { id: accountId, deletedAt: null },
    select: { walletsEnabled: true, walletMigrationPending: true },
  });
  if (!account) return;

  const bookMinor = await getAccountCashBalanceMinor(db, accountId);
  const walletsLive =
    account.walletsEnabled || account.walletMigrationPending;

  const sentences = [];
  if (bookMinor < 0) {
    sentences.push(
      "The account's overall cash (income minus expenses) is still below zero."
    );
  }

  if (walletsLive) {
    const wallets = await db.accountWallet.findMany({
      where: { accountId, deletedAt: null },
      select: { id: true },
    });
    let anyWalletNegative = false;
    for (const w of wallets) {
      const wBal = await walletBalanceMinor(db, w.id);
      if (wBal < 0) {
        anyWalletNegative = true;
        break;
      }
    }
    if (anyWalletNegative) {
      sentences.push(
        "At least one wallet still has a negative balance—every wallet must be zero or above."
      );
    }
  }

  if (sentences.length === 0) return;

  const err = new Error(
    `Cannot turn on "prevent negative cash balance" yet. ${sentences.join(
      " "
    )} Correct your ledger so the account and each wallet are not negative, then try again.`
  );
  err.code = "NEGATIVE_BALANCE_FOR_LOCK";
  throw err;
}

module.exports = {
  getAccountCashBalanceMinor,
  lockAccountForCashBalanceCheck,
  lockAccountsForNegativeCashGuard,
  throwIfExpenseWouldCauseNegativeCashBalance,
  throwIfInvestmentWouldCauseNegativeWalletBalance,
  throwIfCashBalancesAreNegative,
  throwIfCannotEnablePreventNegativeCashBalance,
};
