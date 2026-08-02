"use strict";

/**
 * True when a pending-schedule JSON payload is an investment buy template.
 * @param {unknown} payload
 * @returns {boolean}
 */
function payloadIsInvestTab(payload) {
  return (
    payload != null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.tab === "invest"
  );
}

/**
 * Cancel pending invest schedules for an account when investing is disabled.
 *
 * Leaving them PENDING causes materialize to fail with INVESTING_OFF /
 * BAD_INV_CATEGORY on every processor pass (rows never advance). After
 * re-enable, a long-due RECURRING schedule can burst up to MAX_BURST buys.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} accountId
 * @returns {Promise<number>} number of schedules cancelled
 */
async function cancelPendingInvestSchedules(tx, accountId) {
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

  const now = new Date();
  let cancelled = 0;
  for (const schedule of schedules) {
    if (!payloadIsInvestTab(schedule.payload)) continue;

    await tx.pendingTransactionSchedule.update({
      where: { id: schedule.id },
      data: { status: "CANCELLED", cancelledAt: now },
    });
    cancelled += 1;
  }

  return cancelled;
}

module.exports = {
  payloadIsInvestTab,
  cancelPendingInvestSchedules,
};
