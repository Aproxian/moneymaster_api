class CurrencyChangeConflictError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message = "Account currency changed concurrently; retry with the current rate") {
    super(message);
    this.name = "CurrencyChangeConflictError";
    this.statusCode = 409;
    this.code = "currency_change_conflict";
  }
}

/**
 * Lock the account row and verify its currency still matches the expected
 * pre-conversion currency before applying FX to ledger amounts.
 *
 * Without this, concurrent / double-tapped change-currency requests can both
 * observe the old currency outside the write transaction and multiply every
 * amountMinor by fxRate twice (permanent ledger corruption).
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{ accountId: string, expectedCurrency: string }} args
 * @returns {Promise<{ id: string, currency: string }>}
 */
async function lockAccountCurrencyForUpdate(tx, { accountId, expectedCurrency }) {
  const rows = await tx.$queryRaw`
    SELECT id, currency, deletedAt
    FROM \`Account\`
    WHERE id = ${accountId}
    LIMIT 1
    FOR UPDATE
  `;

  if (!Array.isArray(rows) || rows.length === 0 || rows[0].deletedAt != null) {
    const err = new Error("Account not found");
    err.statusCode = 404;
    throw err;
  }

  const row = rows[0];
  if (row.currency !== expectedCurrency) {
    throw new CurrencyChangeConflictError();
  }

  return { id: row.id, currency: row.currency };
}

module.exports = {
  CurrencyChangeConflictError,
  lockAccountCurrencyForUpdate,
};
