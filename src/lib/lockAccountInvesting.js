/**
 * Serialize investing enable/disable against concurrent investment buys.
 *
 * Disabling investing checks for open holdings outside the write transaction,
 * then flips `investingEnabled` and soft-deletes investment categories. A
 * concurrent buy that already observed `investingEnabled: true` can still
 * create an INVESTMENT row + open Holding after that check — leaving holdings
 * that cash-out rejects while investing is off (funds trapped until re-enable).
 */

class OpenHoldingsDisableError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(
    message = "Cash out or close all investment holdings before disabling investing for this account"
  ) {
    super(message);
    this.name = "OpenHoldingsDisableError";
    this.statusCode = 400;
    this.code = "open_holdings";
  }
}

class InvestingDisabledError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(message = "Investing is disabled for this account") {
    super(message);
    this.name = "InvestingDisabledError";
    this.statusCode = 403;
    this.code = "investing_disabled";
  }
}

/**
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} accountId
 * @returns {Promise<{ id: string, investingEnabled: boolean, currency: string } | null>}
 */
async function lockAccountInvestingForUpdate(tx, accountId) {
  const rows = await tx.$queryRaw`
    SELECT id, investingEnabled, currency, deletedAt
    FROM \`Account\`
    WHERE id = ${accountId}
    LIMIT 1
    FOR UPDATE
  `;

  if (!Array.isArray(rows) || rows.length === 0 || rows[0].deletedAt != null) {
    return null;
  }

  const row = rows[0];
  return {
    id: row.id,
    investingEnabled: Boolean(row.investingEnabled),
    currency: row.currency,
  };
}

/**
 * @param {Iterable<{ quantity: unknown }>} holdings
 */
function hasOpenHoldingQuantity(holdings) {
  for (const h of holdings) {
    if (Number(h.quantity) > 1e-12) return true;
  }
  return false;
}

/**
 * Lock the account and fail closed when any open holding remains before disable.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} accountId
 * @returns {Promise<{ id: string, investingEnabled: boolean, currency: string, alreadyDisabled: boolean }>}
 */
async function assertCanDisableInvestingLocked(tx, accountId) {
  const locked = await lockAccountInvestingForUpdate(tx, accountId);
  if (!locked) {
    const err = new Error("Account not found");
    err.statusCode = 404;
    throw err;
  }

  if (!locked.investingEnabled) {
    return { ...locked, alreadyDisabled: true };
  }

  const holdings = await tx.holding.findMany({
    where: { accountId, deletedAt: null },
    select: { quantity: true },
  });

  if (hasOpenHoldingQuantity(holdings)) {
    throw new OpenHoldingsDisableError();
  }

  return { ...locked, alreadyDisabled: false };
}

/**
 * Lock the account and require investing still enabled before creating a buy.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} accountId
 * @returns {Promise<{ id: string, investingEnabled: boolean, currency: string }>}
 */
async function assertInvestingEnabledLocked(tx, accountId) {
  const locked = await lockAccountInvestingForUpdate(tx, accountId);
  if (!locked) {
    const err = new Error("Account not found");
    err.statusCode = 404;
    throw err;
  }
  if (!locked.investingEnabled) {
    throw new InvestingDisabledError();
  }
  return locked;
}

module.exports = {
  OpenHoldingsDisableError,
  InvestingDisabledError,
  lockAccountInvestingForUpdate,
  hasOpenHoldingQuantity,
  assertCanDisableInvestingLocked,
  assertInvestingEnabledLocked,
};
