/**
 * Net cash attributed to a wallet (minor units): income − expenses − investment buys.
 * @param {import('@prisma/client').Prisma.TransactionClient | import('@prisma/client').PrismaClient} db
 * @param {string} walletId
 */
async function walletBalanceMinor(db, walletId) {
  const txs = await db.transaction.findMany({
    where: { walletId, deletedAt: null, revokedAt: null },
    select: { type: true, amountMinor: true },
  });
  let bal = 0;
  for (const t of txs) {
    if (t.type === "INCOME") bal += t.amountMinor;
    else if (t.type === "EXPENSE") bal -= t.amountMinor;
    else if (t.type === "INVESTMENT") bal -= t.amountMinor;
  }
  return bal;
}

module.exports = { walletBalanceMinor };
