/**
 * Lock an open holding row before quantity/cost-basis mutation.
 *
 * Cash-out (and similar) paths read quantity, check sufficiency, then write
 * absolute remaining values. Without a row lock, concurrent cash-outs can both
 * pass the check and oversell the holding while posting duplicate proceeds.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{ accountId: string, instrumentId: string }} args
 * @returns {Promise<{ id: string, quantity: unknown, costBasisMinor: number, categoryId: string | null } | null>}
 */
async function lockOpenHoldingForUpdate(tx, { accountId, instrumentId }) {
  const rows = await tx.$queryRaw`
    SELECT id, quantity, costBasisMinor, categoryId
    FROM \`Holding\`
    WHERE accountId = ${accountId}
      AND instrumentId = ${instrumentId}
      AND deletedAt IS NULL
    LIMIT 1
    FOR UPDATE
  `;

  if (!Array.isArray(rows) || rows.length === 0) return null;

  const row = rows[0];
  return {
    id: row.id,
    quantity: row.quantity,
    costBasisMinor: Number(row.costBasisMinor),
    categoryId: row.categoryId ?? null,
  };
}

/**
 * Compute the post-cash-out holding state, or throw if quantity is insufficient.
 *
 * @param {{ quantityHeld: number, costBasisMinor: number, quantitySold: number }} args
 */
function planCashOutHoldingUpdate({ quantityHeld, costBasisMinor, quantitySold }) {
  if (!(quantitySold > 0) || !Number.isFinite(quantitySold)) {
    const err = new Error("QTY_TOO_LARGE");
    throw err;
  }
  if (!(quantityHeld >= 0) || !Number.isFinite(quantityHeld)) {
    const err = new Error("QTY_TOO_LARGE");
    throw err;
  }
  if (quantitySold > quantityHeld + 1e-12) {
    const err = new Error("QTY_TOO_LARGE");
    throw err;
  }

  const costRemoved = Math.round(costBasisMinor * (quantitySold / quantityHeld));
  const newCost = Math.max(0, costBasisMinor - costRemoved);
  const newQty = quantityHeld - quantitySold;

  return {
    costRemoved,
    newCost,
    newQty,
    shouldClose: newQty < 1e-12 || newCost <= 0,
  };
}

module.exports = {
  lockOpenHoldingForUpdate,
  planCashOutHoldingUpdate,
};
