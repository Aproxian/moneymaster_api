/**
 * FX conversion for ledger amounts stored as Prisma `Int` / MySQL signed INT
 * (32-bit: -2147483648 … 2147483647).
 *
 * `Math.round(amountMinor * fxRate)` is used by change-currency and
 * cross-currency transfers. Without an upper bound, converting USD→VND/IDR
 * (or transferring into those currencies) silently produces values that
 * cannot be stored — Prisma/MySQL then 500 or, on non-strict SQL modes, clip.
 */

const PRISMA_INT_MIN = -2147483648;
const PRISMA_INT_MAX = 2147483647;

/**
 * Convert a source-currency minor-unit amount by `fxRate`
 * ("1 sourceCurrency = fxRate destCurrency").
 *
 * @param {number} amountMinor
 * @param {number} fxRate
 * @returns {number}
 */
function applyFxToMinorUnits(amountMinor, fxRate) {
  const source = Number(amountMinor);
  const rate = Number(fxRate);
  const converted = Math.round(source * rate);
  if (!Number.isFinite(converted)) {
    const err = new Error("Converted amount is not a finite integer");
    err.code = "FX_AMOUNT_INVALID";
    throw err;
  }
  if (converted > PRISMA_INT_MAX || converted < PRISMA_INT_MIN) {
    const err = new Error(
      "Currency conversion would exceed the maximum stored amount; use a smaller amount or a different fxRate"
    );
    err.code = "FX_AMOUNT_OVERFLOW";
    throw err;
  }
  return converted;
}

function isFxAmountError(err) {
  return (
    Boolean(err) &&
    (err.code === "FX_AMOUNT_OVERFLOW" || err.code === "FX_AMOUNT_INVALID")
  );
}

module.exports = {
  PRISMA_INT_MIN,
  PRISMA_INT_MAX,
  applyFxToMinorUnits,
  isFxAmountError,
};
