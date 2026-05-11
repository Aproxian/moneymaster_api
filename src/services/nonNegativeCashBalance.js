const { walletBalanceMinor } = require("./walletBalance");

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
  const account = await db.account.findFirst({
    where: { id: accountId, deletedAt: null },
    select: {
      preventNegativeCashBalance: true,
      walletsEnabled: true,
      walletMigrationPending: true,
    },
  });
  if (!account?.preventNegativeCashBalance) return;

  const bal = await getAccountCashBalanceMinor(db, accountId);
  if (bal - expenseAmountMinor < 0) {
    const err = new Error(
      "This account is set to prevent cash balance from going below zero"
    );
    err.code = "NEGATIVE_CASH_BALANCE";
    throw err;
  }

  const walletsLive =
    account.walletsEnabled || account.walletMigrationPending;
  if (walletsLive && walletId) {
    const wBal = await walletBalanceMinor(db, walletId);
    if (wBal - expenseAmountMinor < 0) {
      const err = new Error(
        "Not enough balance in this wallet for this amount"
      );
      err.code = "NEGATIVE_CASH_BALANCE";
      throw err;
    }
  }
}

module.exports = {
  getAccountCashBalanceMinor,
  throwIfExpenseWouldCauseNegativeCashBalance,
};
