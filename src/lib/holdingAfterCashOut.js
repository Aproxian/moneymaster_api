/**
 * Proportional cost-basis reduction after a partial (or full) cash-out.
 *
 * Close the holding only when remaining quantity is effectively zero.
 * Integer cents rounding can drive remaining cost to 0 while shares remain
 * (e.g. 2 units bought for 1 cent, then sell 1). Those shares must stay open.
 *
 * @param {{ quantityHeld: number, costBasisMinor: number, quantitySold: number }} args
 * @returns {{ closed: boolean, quantity: number, costBasisMinor: number }}
 */
function holdingAfterCashOut({ quantityHeld, costBasisMinor, quantitySold }) {
  const qtyHeld = Number(quantityHeld);
  const costBasis = Number(costBasisMinor);
  const sold = Number(quantitySold);
  const costRemoved = Math.round(costBasis * (sold / qtyHeld));
  const newCost = Math.max(0, costBasis - costRemoved);
  const newQty = qtyHeld - sold;
  if (newQty < 1e-12) {
    return { closed: true, quantity: 0, costBasisMinor: 0 };
  }
  return { closed: false, quantity: newQty, costBasisMinor: newCost };
}

module.exports = { holdingAfterCashOut };
