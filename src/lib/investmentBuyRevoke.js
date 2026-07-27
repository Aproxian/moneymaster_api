const { CASH_OUT_INVESTMENT } = require("./investmentCategoryKeys");

class BuyRevokeAfterCashOutError extends Error {
  constructor() {
    super(
      "Investment purchases cannot be revoked after a cash-out for this instrument because doing so would corrupt the holding."
    );
    this.name = "BuyRevokeAfterCashOutError";
    this.statusCode = 409;
    this.code = "buy_revoke_after_cash_out_not_supported";
  }
}

/**
 * Prisma `where` that matches non-revoked cash-out rows for an instrument.
 * Current cash-outs store negative `investmentQuantity`; legacy rows rely on
 * the system `CASH_OUT_INVESTMENT` category.
 *
 * @param {{ accountId: string, instrumentId: string }} args
 */
function openCashOutWhere({ accountId, instrumentId }) {
  return {
    accountId,
    instrumentId,
    deletedAt: null,
    revokedAt: null,
    type: "INCOME",
    OR: [
      { investmentQuantity: { lt: 0 } },
      { category: { internalKey: CASH_OUT_INVESTMENT } },
    ],
  };
}

/**
 * Buy revoke subtracts the original lot's full quantity/cost from the live
 * holding. After any cash-out (especially followed by rebuys), that over-removes
 * shares that no longer belong to the revoked lot and can wipe unrelated lots.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{ accountId: string, instrumentId: string }} args
 */
async function assertInvestmentBuyRevokeSafe(tx, { accountId, instrumentId }) {
  const cashOut = await tx.transaction.findFirst({
    where: openCashOutWhere({ accountId, instrumentId }),
    select: { id: true },
  });
  if (cashOut) {
    throw new BuyRevokeAfterCashOutError();
  }
}

/**
 * Decide whether a buy-revoke holding update should soft-delete the row.
 * Closing on `newCost <= 0` alone wipes remaining quantity when cost rounds
 * to zero while shares remain.
 *
 * @param {{ newQty: number, newCost: number }} args
 */
function shouldCloseHoldingAfterBuyRevoke({ newQty, newCost }) {
  void newCost;
  return newQty < 1e-12;
}

module.exports = {
  BuyRevokeAfterCashOutError,
  openCashOutWhere,
  assertInvestmentBuyRevokeSafe,
  shouldCloseHoldingAfterBuyRevoke,
};
