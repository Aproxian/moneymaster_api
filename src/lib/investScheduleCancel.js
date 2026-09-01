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
 * @param {unknown} payload
 * @param {string} instrumentId
 * @returns {boolean}
 */
function payloadReferencesInstrument(payload, instrumentId) {
  if (!payloadIsInvestTab(payload)) return false;
  return (
    typeof payload.instrumentId === "string" &&
    payload.instrumentId === instrumentId
  );
}

/**
 * Cancel PENDING invest schedules whose payload targets any of the given instruments.
 *
 * After an instrument is deactivated (`isActive=false`), materialize throws
 * `BAD_INSTRUMENT` and never advances `nextRunAt`. Stuck due rows can starve
 * the processor `take(200)` batch so other income/expense/invest schedules
 * stop posting.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient | import("@prisma/client").PrismaClient} db
 * @param {string[]} instrumentIds
 * @returns {Promise<number>} number of schedules cancelled
 */
async function cancelPendingInvestSchedulesForInstruments(db, instrumentIds) {
  const ids = [...new Set((instrumentIds || []).filter((id) => typeof id === "string" && id))];
  if (ids.length === 0) return 0;

  const idSet = new Set(ids);
  const schedules = await db.pendingTransactionSchedule.findMany({
    where: {
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
    const instrumentId =
      schedule.payload != null &&
      typeof schedule.payload === "object" &&
      !Array.isArray(schedule.payload) &&
      typeof schedule.payload.instrumentId === "string"
        ? schedule.payload.instrumentId
        : null;
    if (!instrumentId || !idSet.has(instrumentId)) continue;
    if (!payloadIsInvestTab(schedule.payload)) continue;

    await db.pendingTransactionSchedule.update({
      where: { id: schedule.id },
      data: { status: "CANCELLED", cancelledAt: now },
    });
    cancelled += 1;
  }

  return cancelled;
}

module.exports = {
  payloadIsInvestTab,
  payloadReferencesInstrument,
  cancelPendingInvestSchedulesForInstruments,
};
