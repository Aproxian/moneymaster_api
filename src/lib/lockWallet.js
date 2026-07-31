"use strict";

/**
 * Lock an open wallet row before balance check + soft-delete.
 *
 * DELETE /wallets/:walletId previously read balance outside a transaction, then
 * soft-deleted. A concurrent credit can land between those steps and leave funds
 * on a deletedAt != null wallet that list endpoints hide.
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
