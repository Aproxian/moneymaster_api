const { Prisma } = require("@prisma/client");

const { walletBalanceMinor } = require("./walletBalance");

async function lockAccountForCashBalanceCheck(db, accountId) {
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM \`Account\` WHERE id = ${accountId} FOR UPDATE`
  );
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

  await lockAccountForCashBalanceCheck(db, accountId);

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
  throwIfExpenseWouldCauseNegativeCashBalance,
  throwIfCannotEnablePreventNegativeCashBalance,
};
