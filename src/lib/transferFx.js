/**
 * Destination leg amount for a transfer after optional FX conversion.
 * Same-currency transfers keep `amountMinor`. Cross-currency uses
 * `Math.round(amountMinor * fxRate)` and rejects results that round to zero
 * so the source debit cannot land without a destination credit.
 *
 * @param {{ amountMinor: number, fxRate: number | null | undefined, sameCurrency: boolean }} args
 * @returns {number}
 */
function destinationAmountMinor({ amountMinor, fxRate, sameCurrency }) {
  if (sameCurrency) return amountMinor;

  const converted = Math.round(amountMinor * fxRate);
  if (!Number.isFinite(converted) || converted < 1) {
    const err = new Error(
      "Converted transfer amount rounds to zero; increase the amount or check fxRate"
    );
    err.code = "FX_AMOUNT_ROUNDS_TO_ZERO";
    throw err;
  }
  return converted;
}

module.exports = { destinationAmountMinor };
