"use strict";

const {
  assertOpenWalletLocked,
  WalletUnavailableError,
} = require("./lockWallet");

// Keep the transfer-specific name for existing call sites / tests.
class TransferWalletUnavailableError extends WalletUnavailableError {
  constructor(message = "One or more wallets are no longer available for this transfer") {
    super(message);
    this.name = "TransferWalletUnavailableError";
  }
}

/**
 * Lock every referenced open wallet under the transfer write transaction.
 *
 * Transfer create paths historically validated `AccountWallet.deletedAt IS NULL`
 * outside the write txn, then stamped `Transaction.walletId`. A concurrent
 * wallet soft-delete (empty destination pile) could commit first; the transfer
 * then credited/debited a hidden `deletedAt != null` wallet and trapped funds.
 *
 * Wallets are locked in sorted `(accountId, walletId)` order to keep multi-account
 * transfer lock ordering stable.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {Array<{ walletId: string, accountId: string } | null | undefined>} refs
 */
async function assertTransferWalletsLocked(tx, refs) {
  const unique = new Map();
  for (const ref of refs) {
    if (!ref?.walletId || !ref?.accountId) continue;
    unique.set(`${ref.accountId}\0${ref.walletId}`, ref);
  }

  const ordered = [...unique.values()].sort((a, b) => {
    const byAccount = a.accountId.localeCompare(b.accountId);
    if (byAccount !== 0) return byAccount;
    return a.walletId.localeCompare(b.walletId);
  });

  try {
    for (const { walletId, accountId } of ordered) {
      await assertOpenWalletLocked(tx, { walletId, accountId });
    }
  } catch (err) {
    if (err instanceof WalletUnavailableError) {
      throw new TransferWalletUnavailableError();
    }
    throw err;
  }
}

module.exports = {
  TransferWalletUnavailableError,
  assertTransferWalletsLocked,
};
