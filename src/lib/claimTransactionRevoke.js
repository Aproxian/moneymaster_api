class AlreadyRevokedError extends Error {
  constructor() {
    super("Transaction is already revoked");
    this.name = "AlreadyRevokedError";
    this.statusCode = 400;
  }
}

/**
 * Atomically claim a transaction revoke before applying side effects.
 *
 * Concurrent revoke requests can both pass a pre-transaction `revokedAt`
 * check. Claiming with `updateMany(... revokedAt: null)` ensures only one
 * writer proceeds to mutate holdings or other derived state.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{ transactionId: string, accountId: string, revokedAt: Date }} args
 */
async function claimTransactionRevoke(tx, { transactionId, accountId, revokedAt }) {
  const claimed = await tx.transaction.updateMany({
    where: {
      id: transactionId,
      accountId,
      deletedAt: null,
      revokedAt: null,
    },
    data: { revokedAt },
  });

  if (claimed.count !== 1) {
    throw new AlreadyRevokedError();
  }
}

module.exports = {
  AlreadyRevokedError,
  claimTransactionRevoke,
};
