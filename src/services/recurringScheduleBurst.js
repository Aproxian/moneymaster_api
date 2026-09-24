const { advanceScheduleUtc } = require("./advanceRecurrence");

/**
 * Post due recurring slots until cash rules or the burst cap stop the run.
 *
 * Catch-up used to live in one database transaction that rolled back entirely
 * when a later slot threw NEGATIVE_CASH_BALANCE. Slots that already fit were
 * discarded and nextRunAt never moved, so the schedule retried the same
 * over-budget backlog forever.
 *
 * This helper stops on that error and leaves nextRunAt on the slot that did
 * not post. The caller commits the slots that succeeded.
 *
 * @param {{
 *   startSlot: Date,
 *   now: Date,
 *   recurrenceUnit: string,
 *   intervalCount: number,
 *   hourOfDay: number | null | undefined,
 *   maxBurst: number,
 *   materialize: (occurredAt: Date) => Promise<unknown>,
 * }} args
 */
async function materializeRecurringUntilBlocked({
  startSlot,
  now,
  recurrenceUnit,
  intervalCount,
  hourOfDay,
  maxBurst,
  materialize,
}) {
  let slot = new Date(startSlot);
  let runs = 0;
  let stoppedForNegativeCash = false;

  while (slot <= now && runs < maxBurst) {
    try {
      await materialize(new Date(slot));
    } catch (err) {
      if (err && err.code === "NEGATIVE_CASH_BALANCE") {
        stoppedForNegativeCash = true;
        break;
      }
      throw err;
    }
    runs += 1;
    slot = advanceScheduleUtc(slot, recurrenceUnit, intervalCount, hourOfDay);
  }

  return {
    nextRunAt: slot,
    runs,
    stoppedForNegativeCash,
  };
}

module.exports = { materializeRecurringUntilBlocked };
