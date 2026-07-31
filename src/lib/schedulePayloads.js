"use strict";

function payloadReferencesWallet(payload, walletId) {
  return (
    payload != null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.walletId === walletId
  );
}

async function countPendingSchedulesForWallet(prismaClient, accountId, walletId) {
  const schedules = await prismaClient.pendingTransactionSchedule.findMany({
    where: {
      accountId,
      status: "PENDING",
      cancelledAt: null,
    },
    select: {
      payload: true,
    },
  });

  return schedules.reduce(
    (count, schedule) =>
      payloadReferencesWallet(schedule.payload, walletId) ? count + 1 : count,
    0
  );
}

/**
 * Clear payload.walletId on pending schedules when wallets are disabled/cancelled.
 * Materialize fails closed with WALLET_NOT_ALLOWED if a walletId remains while
 * walletsEnabled is false, leaving the row stuck PENDING forever.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} accountId
 * @returns {Promise<number>} number of payloads rewritten
 */
async function stripWalletIdsFromPendingSchedules(tx, accountId) {
  const schedules = await tx.pendingTransactionSchedule.findMany({
    where: {
      accountId,
      status: "PENDING",
      cancelledAt: null,
    },
    select: {
      id: true,
      payload: true,
    },
  });

  let updated = 0;
  for (const schedule of schedules) {
    const payload = schedule.payload;
    if (
      payload == null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      typeof payload.walletId !== "string"
    ) {
      continue;
    }

    const nextPayload = { ...payload };
    delete nextPayload.walletId;

    await tx.pendingTransactionSchedule.update({
      where: { id: schedule.id },
      data: { payload: nextPayload },
    });
    updated += 1;
  }

  return updated;
}

module.exports = {
  countPendingSchedulesForWallet,
  payloadReferencesWallet,
  stripWalletIdsFromPendingSchedules,
};
