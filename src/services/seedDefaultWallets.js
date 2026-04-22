const { WALLET_CARD, WALLET_CASH } = require("../lib/walletInternalKeys");

/**
 * Creates default 💵 / 💳 wallets when none exist (idempotent).
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} accountId
 */
async function seedDefaultWallets(tx, accountId) {
  const n = await tx.accountWallet.count({
    where: { accountId, deletedAt: null },
  });
  if (n > 0) return;

  await tx.accountWallet.createMany({
    data: [
      { accountId, emoji: "💵", sortOrder: 0, internalKey: WALLET_CASH },
      { accountId, emoji: "💳", sortOrder: 1, internalKey: WALLET_CARD },
    ],
  });
}

/** Standalone helper for scripts / one-off. */
async function seedDefaultWalletsStandalone(accountId) {
  const { prisma } = require("../prisma");
  await prisma.$transaction((tx) => seedDefaultWallets(tx, accountId));
}

module.exports = { seedDefaultWallets, seedDefaultWalletsStandalone };
