const { TRANSFER_RECEIVE, TRANSFER_SEND } = require("../lib/transferCategoryKeys");

/**
 * Lazily creates transfer categories on an account (manual entry blocked via `lockedForManualEntry`).
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} accountId
 */
async function ensureTransferCategories(tx, accountId) {
  let send = await tx.category.findFirst({
    where: { accountId, internalKey: TRANSFER_SEND, deletedAt: null },
    select: { id: true },
  });
  if (!send) {
    send = await tx.category.create({
      data: {
        accountId,
        type: "EXPENSE",
        name: "Transfer (send)",
        icon: "↗️",
        internalKey: TRANSFER_SEND,
        lockedForManualEntry: true,
      },
      select: { id: true },
    });
  }

  let recv = await tx.category.findFirst({
    where: { accountId, internalKey: TRANSFER_RECEIVE, deletedAt: null },
    select: { id: true },
  });
  if (!recv) {
    recv = await tx.category.create({
      data: {
        accountId,
        type: "INCOME",
        name: "Transfer (receive)",
        icon: "↙️",
        internalKey: TRANSFER_RECEIVE,
        lockedForManualEntry: true,
      },
      select: { id: true },
    });
  }

  await tx.category.updateMany({
    where: {
      accountId,
      deletedAt: null,
      internalKey: { in: [TRANSFER_SEND, TRANSFER_RECEIVE] },
    },
    data: { lockedForManualEntry: true },
  });

  return { sendCategoryId: send.id, receiveCategoryId: recv.id };
}

module.exports = { ensureTransferCategories };
