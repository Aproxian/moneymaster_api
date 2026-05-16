const { TRANSFER_RECEIVE, TRANSFER_SEND } = require("../lib/transferCategoryKeys");

/**
 * Lazily creates transfer categories on an account (manual entry blocked via `lockedForManualEntry`).
 * @param {import('@prisma/client').Prisma.TransactionClient} tx
 * @param {string} accountId
 */
async function ensureTransferCategories(tx, accountId) {
  const send = await ensureTransferCategory(tx, accountId, TRANSFER_SEND, {
    type: "EXPENSE",
    name: "Transfer (send)",
    icon: "↗️",
  });

  const recv = await ensureTransferCategory(tx, accountId, TRANSFER_RECEIVE, {
    type: "INCOME",
    name: "Transfer (receive)",
    icon: "↙️",
  });

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

async function ensureTransferCategory(tx, accountId, internalKey, defaults) {
  const active = await tx.category.findFirst({
    where: { accountId, internalKey, deletedAt: null },
    select: { id: true },
  });
  if (active) return active;

  const softDeleted = await tx.category.findFirst({
    where: { accountId, internalKey, deletedAt: { not: null } },
    select: { id: true },
  });
  if (softDeleted) {
    return tx.category.update({
      where: { id: softDeleted.id },
      data: {
        deletedAt: null,
        type: defaults.type,
        icon: defaults.icon,
        internalKey,
        lockedForManualEntry: true,
      },
      select: { id: true },
    });
  }

  return tx.category.create({
    data: {
      accountId,
      ...defaults,
      internalKey,
      lockedForManualEntry: true,
    },
    select: { id: true },
  });
}

module.exports = { ensureTransferCategories };
