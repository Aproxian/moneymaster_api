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
        const fresh = await tx.pendingTransactionSchedule.findFirst({
          where: { id: sch.id, status: "PENDING", cancelledAt: null },
        });
        if (!fresh) return;

        if (fresh.kind === "DELAY_ONCE") {
          const at = fresh.executeAt ?? fresh.nextRunAt;
          if (!at || at > now) return;
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
          if (!fresh.recurrenceUnit) return;
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
        }
      });
    } catch (err) {
      // eslint-disable-next-line no-console -- operational visibility
      console.error("[schedules] failed row", sch.id, err?.message || err);
    }
  }
}

module.exports = { processPendingSchedulesForUser };
