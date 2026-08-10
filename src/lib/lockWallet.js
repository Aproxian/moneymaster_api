"use strict";

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

module.exports = {
  lockOpenWalletForUpdate,
};
