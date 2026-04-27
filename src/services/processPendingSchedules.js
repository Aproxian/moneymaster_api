const { prisma } = require("../prisma");
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

  const schedules = await prisma.pendingTransactionSchedule.findMany({
    where: {
      status: "PENDING",
      cancelledAt: null,
      account: {
        deletedAt: null,
        members: { some: { userId } },
      },
      OR: [
        { kind: "DELAY_ONCE", executeAt: { lte: now } } ,
        { kind: "RECURRING", nextRunAt: { lte: now } } ,
      ],
    },
    orderBy: [{ nextRunAt: "asc" }, { createdAt: "asc" }],
    take: 200,
  });

  for (const sch of schedules) {
    try {
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.pendingTransactionSchedule.updateMany({
          where: {
            id: sch.id,
            status: "PENDING",
            cancelledAt: null,
            OR: [
              { kind: "DELAY_ONCE", executeAt: { lte: now } },
              { kind: "RECURRING", nextRunAt: { lte: now } },
            ],
          },
          data: { lastRunAt: now },
        });
        if (claimed.count !== 1) return;

        const fresh = await tx.pendingTransactionSchedule.findUnique({
          where: { id: sch.id },
        });
        if (!fresh) throw new Error("SCHEDULE_NOT_FOUND_AFTER_CLAIM");

        if (fresh.kind === "DELAY_ONCE") {
          const at = fresh.executeAt ?? fresh.nextRunAt;
          if (!at || at > now) throw new Error("SCHEDULE_NOT_DUE_AFTER_CLAIM");
          await materializeScheduledPayload(tx, {
            accountId: fresh.accountId,
            userId: fresh.createdByUserId,
            occurredAt: at,
            payload: fresh.payload,
          });
          await tx.pendingTransactionSchedule.update({
            where: { id: fresh.id },
            data: { status: "COMPLETED", lastRunAt: now },
          });
          return;
        }

        if (fresh.kind === "RECURRING") {
          if (!fresh.recurrenceUnit) throw new Error("SCHEDULE_MISSING_RECURRENCE_UNIT");
          let slot = new Date(fresh.nextRunAt);
          let runs = 0;
          while (slot <= now && runs < MAX_BURST) {
            await materializeScheduledPayload(tx, {
              accountId: fresh.accountId,
              userId: fresh.createdByUserId,
              occurredAt: new Date(slot),
              payload: fresh.payload,
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
          return;
        }

        throw new Error("UNKNOWN_SCHEDULE_KIND");
      });
    } catch (err) {
      // eslint-disable-next-line no-console -- operational visibility
      console.error("[schedules] failed row", sch.id, err?.message || err);
    }
  }
}

module.exports = { processPendingSchedulesForUser };
