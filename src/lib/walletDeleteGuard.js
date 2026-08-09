"use strict";

const { walletBalanceMinor } = require("../services/walletBalance");

/**
 * Soft-deleting a wallet previously only required walletBalanceMinor === 0.
 * Offsetting non-revoked legs (income +100 / expense +100) net to zero, so
 * DELETE succeeded while Transaction.walletId rows remained attached.
 * Revoking or reassigning one leg then resurrects nonzero funds on a
 * deletedAt != null wallet that GET /wallets hides.
 */

class WalletHasOpenTransactionsError extends Error {
  /**
   * @param {number} openTransactionCount
   */
  constructor(openTransactionCount) {
    super("WALLET_HAS_OPEN_TRANSACTIONS");
    this.name = "WalletHasOpenTransactionsError";
    this.statusCode = 409;
    this.code = "wallet_has_open_transactions";
    this.openTransactionCount = openTransactionCount;
  }
}

class WalletBalanceNonemptyError extends Error {
  /**
   * @param {number} balanceMinor
   */
  constructor(balanceMinor) {
    super("WALLET_BALANCE_NONEMPTY");
    this.name = "WalletBalanceNonemptyError";
    this.statusCode = 400;
    this.balanceMinor = balanceMinor;
  }
}

/**
 * Lock an open wallet row before emptiness checks + soft-delete.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{ walletId: string, accountId: string }} args
 * @returns {Promise<{ id: string } | null>}
 */
async function lockOpenWalletForUpdate(tx, { walletId, accountId }) {
  const rows = await tx.$queryRaw`
    SELECT id
    FROM \`AccountWallet\`
    WHERE id = ${walletId}
      AND accountId = ${accountId}
      AND deletedAt IS NULL
    LIMIT 1
    FOR UPDATE
  `;

  if (!Array.isArray(rows) || rows.length === 0) return null;
  return { id: rows[0].id };
}

/**
 * Count non-deleted, non-revoked ledger rows still stamped with this wallet.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient | import("@prisma/client").PrismaClient} db
 * @param {string} walletId
 * @returns {Promise<number>}
 */
async function countOpenWalletTransactions(db, walletId) {
  return db.transaction.count({
    where: { walletId, deletedAt: null, revokedAt: null },
  });
}

/**
 * Fail closed unless the locked wallet has zero net balance AND no open
 * ledger attachments. Call inside an interactive Prisma transaction.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{ walletId: string, accountId: string }} args
 * @returns {Promise<{ id: string }>}
 */
async function assertWalletDeletable(tx, { walletId, accountId }) {
  const locked = await lockOpenWalletForUpdate(tx, { walletId, accountId });
  if (!locked) {
    const err = new Error("WALLET_NOT_FOUND");
    err.statusCode = 404;
    throw err;
  }

  const bal = await walletBalanceMinor(tx, walletId);
  if (bal !== 0) {
    throw new WalletBalanceNonemptyError(bal);
  }

  const openTransactionCount = await countOpenWalletTransactions(tx, walletId);
  if (openTransactionCount > 0) {
    throw new WalletHasOpenTransactionsError(openTransactionCount);
  }

  return locked;
}

module.exports = {
  WalletHasOpenTransactionsError,
  WalletBalanceNonemptyError,
  lockOpenWalletForUpdate,
  countOpenWalletTransactions,
  assertWalletDeletable,
};
