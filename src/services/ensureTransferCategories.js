const { TRANSFER_RECEIVE, TRANSFER_SEND } = require("../lib/transferCategoryKeys");

/**
 * Lazily creates hidden transfer categories on an account (manual pick is blocked by internalKey).
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
      },
      select: { id: true },
    });
  }

  return { sendCategoryId: send.id, receiveCategoryId: recv.id };
}

module.exports = { ensureTransferCategories };
