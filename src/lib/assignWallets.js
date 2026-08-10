"use strict";

const { lockOpenWalletForUpdate } = require("./lockWallet");
const { walletBalanceMinor } = require("../services/walletBalance");

class AssignWalletsError extends Error {
  /**
   * @param {string} message
   * @param {{ statusCode?: number, code?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = "AssignWalletsError";
    this.statusCode = opts.statusCode ?? 400;
    this.code = opts.code;
  }
}

/**
 * Ledger contribution of a row toward walletBalanceMinor (income − expense − invest).
 * @param {{ type: string, amountMinor: number }} row
 */
function walletContributionMinor(row) {
  if (row.type === "INCOME") return row.amountMinor;
  if (row.type === "EXPENSE" || row.type === "INVESTMENT") return -row.amountMinor;
  return 0;
}

/**
 * Apply bulk wallet assignments under row locks so concurrent wallet
 * soft-delete / cancel-migration / disable cannot leave funds on a hidden
 * `deletedAt != null` wallet. When preventNegativeCashBalance is on, also
 * reject batches that would push any open wallet pile below zero.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{
 *   accountId: string,
 *   assignments: Array<{ transactionId: string, walletId: string }>,
 * }} args
 * @returns {Promise<{ updated: number }>}
 */
async function applyWalletAssignments(tx, { accountId, assignments }) {
  const txIds = assignments.map((a) => a.transactionId);
  if (new Set(txIds).size !== txIds.length) {
    throw new AssignWalletsError("Duplicate transactionId in assignments", {
      statusCode: 400,
      code: "duplicate_transaction_id",
    });
  }

  const accountRows = await tx.$queryRaw`
    SELECT id, preventNegativeCashBalance, walletsEnabled, walletMigrationPending
    FROM \`Account\`
    WHERE id = ${accountId}
      AND deletedAt IS NULL
    LIMIT 1
    FOR UPDATE
  `;
  if (!Array.isArray(accountRows) || accountRows.length === 0) {
    throw new AssignWalletsError("Account not found", { statusCode: 404 });
  }
  const account = accountRows[0];
  const walletsLive =
    Boolean(account.walletsEnabled) || Boolean(account.walletMigrationPending);
  if (!walletsLive) {
    throw new AssignWalletsError("Wallets are not enabled for this account", {
      statusCode: 400,
    });
  }

  const targetWalletIds = [...new Set(assignments.map((a) => a.walletId))];
  const rows = await tx.transaction.findMany({
    where: {
      id: { in: txIds },
      accountId,
      deletedAt: null,
      revokedAt: null,
    },
    select: { id: true, type: true, amountMinor: true, walletId: true },
  });
  if (rows.length !== txIds.length) {
    throw new AssignWalletsError(
      "One or more transactions were not found or are not assignable",
      { statusCode: 400 }
    );
  }

  const involvedWalletIds = new Set(targetWalletIds);
  for (const row of rows) {
    if (row.walletId) involvedWalletIds.add(row.walletId);
  }

  /** @type {Set<string>} */
  const lockedOpenWalletIds = new Set();
  for (const walletId of [...involvedWalletIds].sort()) {
    const locked = await lockOpenWalletForUpdate(tx, { walletId, accountId });
    if (locked) lockedOpenWalletIds.add(walletId);
  }

  for (const walletId of targetWalletIds) {
    if (!lockedOpenWalletIds.has(walletId)) {
      throw new AssignWalletsError(
        "One or more wallets are no longer available for assignment",
        { statusCode: 409, code: "wallet_unavailable" }
      );
    }
  }

  const preventNegative = Boolean(account.preventNegativeCashBalance);
  if (preventNegative) {
    const rowById = new Map(rows.map((r) => [r.id, r]));
    /** @type {Map<string, number>} */
    const deltas = new Map();

    for (const a of assignments) {
      const row = rowById.get(a.transactionId);
      if (!row) continue;
      if (row.walletId === a.walletId) continue;

      const contrib = walletContributionMinor(row);
      if (row.walletId && lockedOpenWalletIds.has(row.walletId)) {
        deltas.set(row.walletId, (deltas.get(row.walletId) || 0) - contrib);
      }
      deltas.set(a.walletId, (deltas.get(a.walletId) || 0) + contrib);
    }

    for (const [walletId, delta] of deltas) {
      if (delta === 0) continue;
      if (!lockedOpenWalletIds.has(walletId)) continue;
      const bal = await walletBalanceMinor(tx, walletId);
      if (bal + delta < 0) {
        throw new AssignWalletsError(
          "Not enough balance in this wallet for this amount",
          { statusCode: 400, code: "NEGATIVE_CASH_BALANCE" }
        );
      }
    }
  }

  for (const a of assignments) {
    const updated = await tx.transaction.updateMany({
      where: {
        id: a.transactionId,
        accountId,
        deletedAt: null,
        revokedAt: null,
      },
      data: { walletId: a.walletId },
    });
    if (updated.count !== 1) {
      throw new AssignWalletsError(
        "One or more transactions were not found or are not assignable",
        { statusCode: 400 }
      );
    }
  }

  return { updated: assignments.length };
}

module.exports = {
  AssignWalletsError,
  walletContributionMinor,
  applyWalletAssignments,
};
