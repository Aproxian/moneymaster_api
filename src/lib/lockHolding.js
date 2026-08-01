/**
 * Lock an open holding row before quantity/cost-basis mutation.
 *
 * Buy revoke (and cash-out) paths read quantity/cost, then write absolute
 * remaining values. Without a row lock, a concurrent buy that uses relative
 * `{ increment }` can commit between the read and absolute write, and the
 * revoke overwrites that increment — holdings diverge from the ledger.
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
 * Plan holding updates when revoking an investment buy, from a locked read.
 *
 * @param {{
 *   quantityHeld: number,
 *   costBasisMinor: number,
 *   investmentQuantity: unknown,
 *   amountMinor: number,
 * }} args
 */
function planBuyRevokeHoldingUpdate({
  quantityHeld,
  costBasisMinor,
  investmentQuantity,
  amountMinor,
}) {
  let qtyDec =
    investmentQuantity != null
      ? Number(investmentQuantity)
      : costBasisMinor > 0
        ? quantityHeld * (amountMinor / costBasisMinor)
        : 0;

  if (!Number.isFinite(qtyDec) || qtyDec < 0) qtyDec = 0;
  if (qtyDec > quantityHeld) qtyDec = quantityHeld;

  const costDec = Math.min(amountMinor, costBasisMinor);
  const newCost = Math.max(0, costBasisMinor - costDec);
  const newQty = Math.max(0, quantityHeld - qtyDec);

  return {
    qtyDec,
    costDec,
    newQty,
    newCost,
    shouldClose: newQty < 1e-12 || newCost <= 0,
  };
}

module.exports = {
  lockOpenHoldingForUpdate,
  planBuyRevokeHoldingUpdate,
};
