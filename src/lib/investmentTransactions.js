const { CASH_OUT_INVESTMENT } = require("./investmentCategoryKeys");

/**
 * Cash-out rows reduce holdings when they are created. The current transaction
 * model does not retain the removed cost basis needed to reverse that update.
 *
 * @param {object | null | undefined} transaction
 * @returns {boolean}
 */
function isInvestmentCashOut(transaction) {
  if (
    transaction?.type !== "INCOME" ||
    !transaction.instrumentId
  ) {
    return false;
  }

  const quantity =
    transaction.investmentQuantity == null
      ? null
      : Number(transaction.investmentQuantity);

  return (
    (Number.isFinite(quantity) && quantity < 0) ||
    transaction.category?.internalKey === CASH_OUT_INVESTMENT
  );
}

module.exports = { isInvestmentCashOut };
