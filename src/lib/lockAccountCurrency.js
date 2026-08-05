/**
 * Serialize account currency changes against concurrent ledger writers.
 *
 * change-currency converts existing Transaction.amountMinor rows then flips
 * Account.currency. Creates (and schedule materialization) historically
 * pre-read currency outside their write transaction and stamped that value on
 * insert — so a raced create can land an unconverted old-currency row after
 * conversion commits. Balances sum amountMinor with no per-row currency check,
 * producing permanent silent money corruption.
 *
 * Writers must take Account FOR UPDATE and fail closed when the locked currency
 * no longer matches the amount scale they prepared (HTTP 409). Converters use
 * the same lock so they serialize with those writers.
 */

class AccountCurrencyChangedError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(
    message = "Account currency changed concurrently; retry with the current currency"
  ) {
    super(message);
    this.name = "AccountCurrencyChangedError";
    this.statusCode = 409;
    this.code = "account_currency_changed";
  }
}

/**
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} accountId
 * @returns {Promise<{ id: string, currency: string } | null>}
 */
async function lockAccountCurrencyForUpdate(tx, accountId) {
  const rows = await tx.$queryRaw`
    SELECT id, currency, deletedAt
    FROM \`Account\`
    WHERE id = ${accountId}
    LIMIT 1
    FOR UPDATE
  `;

  if (!Array.isArray(rows) || rows.length === 0 || rows[0].deletedAt != null) {
    return null;
  }

  const row = rows[0];
  return { id: row.id, currency: row.currency };
}

/**
 * Lock the account and require currency still matches the caller's expected
 * pre-read / pre-conversion value.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} accountId
 * @param {string} expectedCurrency
 * @returns {Promise<{ id: string, currency: string }>}
 */
async function assertAccountCurrencyLocked(tx, accountId, expectedCurrency) {
  const locked = await lockAccountCurrencyForUpdate(tx, accountId);
  if (!locked) {
    const err = new Error("Account not found");
    err.statusCode = 404;
    throw err;
  }
  if (locked.currency !== expectedCurrency) {
    throw new AccountCurrencyChangedError();
  }
  return locked;
}

/**
 * Lock multiple accounts in stable id order (deadlock-safe) and require each
 * currency still matches the caller's expected pre-read value.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {Array<{ accountId: string, expectedCurrency: string }>} accounts
 * @returns {Promise<Array<{ id: string, currency: string }>>}
 */
async function assertAccountsCurrencyLocked(tx, accounts) {
  const sorted = [...accounts].sort((a, b) =>
    String(a.accountId).localeCompare(String(b.accountId))
  );
  const locked = [];
  for (const a of sorted) {
    locked.push(await assertAccountCurrencyLocked(tx, a.accountId, a.expectedCurrency));
  }
  return locked;
}

module.exports = {
  AccountCurrencyChangedError,
  lockAccountCurrencyForUpdate,
  assertAccountCurrencyLocked,
  assertAccountsCurrencyLocked,
};
