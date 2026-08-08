/**
 * Convert an account-currency minor-unit amount with the same rounding used by
 * change-currency (`Math.round(amountMinor * fxRate)`).
 *
 * Already-zero amounts stay zero. Non-zero amounts that round to 0 are rejected
 * so a weak fxRate (e.g. VND→USD) cannot silently wipe ledger value.
 *
 * @param {number} amountMinor
 * @param {number} fxRate
 * @returns {number}
 */
function convertMinorUnits(amountMinor, fxRate) {
  const source = Number(amountMinor);
  const converted = Math.round(source * fxRate);
  if (!Number.isFinite(converted)) {
    const err = new Error("Converted amount is not a finite integer");
    err.code = "FX_AMOUNT_INVALID";
    throw err;
  }
  if (source !== 0 && converted === 0) {
    const err = new Error(
      "Currency conversion would round one or more amounts to zero; increase the amounts or check fxRate"
    );
    err.code = "FX_AMOUNT_ROUNDS_TO_ZERO";
    throw err;
  }
  return converted;
}

module.exports = { convertMinorUnits };
