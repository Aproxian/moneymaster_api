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
          const claimed = await tx.pendingTransactionSchedule.updateMany({
            where: {
              id: fresh.id,
              status: "PENDING",
              cancelledAt: null,
              nextRunAt: fresh.nextRunAt,
            },
            data: { status: "COMPLETED", lastRunAt: now },
          });
          if (claimed.count === 0) return;

          await materializeScheduledPayload(tx, {
            accountId: fresh.accountId,
            userId: fresh.createdByUserId,
            occurredAt: at,
            payload: fresh.payload,
            scheduleKind: fresh.kind,
          });
          return;
        }

        if (fresh.kind === "RECURRING") {
          if (!fresh.recurrenceUnit) return;
          let slot = new Date(fresh.nextRunAt);
          const runSlots = [];
          while (slot <= now && runSlots.length < MAX_BURST) {
            runSlots.push(new Date(slot));
            slot = advanceScheduleUtc(
              slot,
              fresh.recurrenceUnit,
              fresh.intervalCount,
              fresh.hourOfDay
            );
          }
          if (runSlots.length === 0) return;

          const claimed = await tx.pendingTransactionSchedule.updateMany({
            where: {
              id: fresh.id,
              status: "PENDING",
              cancelledAt: null,
              nextRunAt: fresh.nextRunAt,
            },
            data: {
              nextRunAt: slot,
              lastRunAt: now,
            },
          });
          if (claimed.count === 0) return;

          for (const runSlot of runSlots) {
            await materializeScheduledPayload(tx, {
              accountId: fresh.accountId,
              userId: fresh.createdByUserId,
              occurredAt: runSlot,
              payload: fresh.payload,
              scheduleKind: fresh.kind,
            });
          }
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
