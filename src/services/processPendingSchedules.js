const { prisma } = require("../prisma");
const { logApp } = require("../lib/fileLogger");
const { materializeScheduledPayload } = require("./materializeScheduledPayload");
const { materializeRecurringUntilBlocked } = require("./recurringScheduleBurst");

const MAX_BURST = 500;

/**
 * Materializes due delayed / recurring transaction templates for every account this user can access.
 * Intended to run after login / refresh / explicit client ping (no cron).
 * @param {string} userId
 */
async function processPendingSchedulesForUser(userId) {
  const now = new Date();

  /** Use nextRunAt for all kinds (DELAY_ONCE sets it equal to executeAt). Relying only on
   * executeAt missed rows when executeAt was null or out of sync in older data. */
  const schedules = await prisma.pendingTransactionSchedule.findMany({
    where: {
      status: "PENDING",
      cancelledAt: null,
      nextRunAt: { lte: now },
      account: {
        deletedAt: null,
        members: { some: { userId } },
      },
    },
    orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
    take: 200,
  });

  for (const sch of schedules) {
    try {
      const outcome = await prisma.$transaction(async (tx) => {
        const fresh = await tx.pendingTransactionSchedule.findFirst({
          where: { id: sch.id, status: "PENDING", cancelledAt: null },
        });
        if (!fresh) return;

        if (fresh.kind === "DELAY_ONCE") {
          const at = fresh.nextRunAt ?? fresh.executeAt;
          if (!at || at > now) return;
          await materializeScheduledPayload(tx, {
            accountId: fresh.accountId,
            userId: fresh.createdByUserId,
            occurredAt: at,
            payload: fresh.payload,
            scheduleKind: fresh.kind,
          });
          await tx.pendingTransactionSchedule.update({
            where: { id: fresh.id },
            data: { status: "COMPLETED", lastRunAt: now },
          });
          return;
        }

        if (fresh.kind === "RECURRING") {
          if (!fresh.recurrenceUnit) return;
          const burst = await materializeRecurringUntilBlocked({
            startSlot: fresh.nextRunAt,
            now,
            recurrenceUnit: fresh.recurrenceUnit,
            intervalCount: fresh.intervalCount,
            hourOfDay: fresh.hourOfDay,
            maxBurst: MAX_BURST,
            materialize: (occurredAt) =>
              materializeScheduledPayload(tx, {
                accountId: fresh.accountId,
                userId: fresh.createdByUserId,
                occurredAt,
                payload: fresh.payload,
                scheduleKind: fresh.kind,
              }),
          });

          // Nothing posted. Leave nextRunAt where it is so a later login can
          // retry once the balance can cover this slot. Rethrow so the row is
          // logged like other materialize failures.
          if (burst.runs === 0) {
            if (burst.stoppedForNegativeCash) {
              const err = new Error(
                "This account is set to prevent cash balance from going below zero"
              );
              err.code = "NEGATIVE_CASH_BALANCE";
              throw err;
            }
            return;
          }

          await tx.pendingTransactionSchedule.update({
            where: { id: fresh.id },
            data: {
              nextRunAt: burst.nextRunAt,
              lastRunAt: now,
            },
          });

          return {
            pausedForNegativeCash: burst.stoppedForNegativeCash,
            posted: burst.runs,
            nextRunAt: burst.nextRunAt,
          };
        }
      });
      if (outcome?.pausedForNegativeCash) {
        logApp("WARN", "Schedules", "paused catch-up at negative cash balance", {
          scheduleId: sch.id,
          posted: outcome.posted,
          nextRunAt:
            outcome.nextRunAt instanceof Date
              ? outcome.nextRunAt.toISOString()
              : null,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console -- operational visibility
      console.error("[schedules] failed row", sch.id, err?.message || err);
      logApp("ERROR", "Schedules", "failed row", {
        scheduleId: sch.id,
        error: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
      });
    }
  }
}

module.exports = { processPendingSchedulesForUser };
