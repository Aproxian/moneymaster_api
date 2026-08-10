"use strict";

class WalletUnavailableError extends Error {
  constructor(message = "Wallet is no longer available") {
    super(message);
    this.name = "WalletUnavailableError";
    this.statusCode = 409;
    this.code = "wallet_unavailable";
  }
}

/**
 * Lock an open wallet row (`SELECT … FOR UPDATE`).
 *
 * Shared with wallet delete / lifecycle paths (see open PR #48 / #56): callers must
 * re-check invariants under this lock before mutating walletId attachments.
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
 * Fail closed when a ledger writer would stamp a soft-deleted / missing wallet.
 *
 * Create / buy / cash-out historically validated `deletedAt IS NULL` outside the
 * write txn (or with a non-locking read), then inserted `Transaction.walletId`.
 * Concurrent empty-wallet delete could commit first and trap funds on a hidden wallet.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{ walletId: string, accountId: string }} args
 * @returns {Promise<{ id: string }>}
 */
async function assertOpenWalletLocked(tx, { walletId, accountId }) {
  const locked = await lockOpenWalletForUpdate(tx, { walletId, accountId });
  if (!locked) {
    throw new WalletUnavailableError();
  }
  return locked;
}

module.exports = {
  WalletUnavailableError,
  lockOpenWalletForUpdate,
  assertOpenWalletLocked,
};
