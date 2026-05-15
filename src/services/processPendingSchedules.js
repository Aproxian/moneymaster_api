const { prisma } = require("../prisma");
const { logApp } = require("../lib/fileLogger");
const { advanceScheduleUtc } = require("./advanceRecurrence");
const { materializeScheduledPayload } = require("./materializeScheduledPayload");

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
      await prisma.$transaction(async (tx) => {
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
          let slot = new Date(fresh.nextRunAt);
          let runs = 0;
          while (slot <= now && runs < MAX_BURST) {
            await materializeScheduledPayload(tx, {
              accountId: fresh.accountId,
              userId: fresh.createdByUserId,
              occurredAt: new Date(slot),
              payload: fresh.payload,
              scheduleKind: fresh.kind,
            });
            runs += 1;
            slot = advanceScheduleUtc(
              slot,
              fresh.recurrenceUnit,
              fresh.intervalCount,
              fresh.hourOfDay
            );
          }
          await tx.pendingTransactionSchedule.update({
            where: { id: fresh.id },
            data: {
              nextRunAt: slot,
              lastRunAt: now,
            },
          });
        }
      });
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
