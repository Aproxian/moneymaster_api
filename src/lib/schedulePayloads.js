"use strict";

function payloadReferencesCategory(payload, categoryId) {
  return (
    payload != null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.categoryId === categoryId
  );
}

async function countPendingSchedulesForCategory(prismaClient, accountId, categoryId) {
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
      payloadReferencesCategory(schedule.payload, categoryId) ? count + 1 : count,
    0
  );
}

/**
 * Cancel pending schedules for a category whose creators are no longer allowed
 * to post to that category (member-access restriction). Leaving them PENDING
 * makes materialize throw CATEGORY_ACCESS_DENIED forever and can starve take(200).
 *
 * @param {import("@prisma/client").Prisma.TransactionClient | import("@prisma/client").PrismaClient} client
 * @param {{ accountId: string; categoryId: string; allowedUserIds: Iterable<string> }} args
 * @returns {Promise<number>}
 */
async function cancelPendingSchedulesForCategoryDeniedCreators(
  client,
  { accountId, categoryId, allowedUserIds }
) {
  const allowed = new Set(allowedUserIds);
  const schedules = await client.pendingTransactionSchedule.findMany({
    where: {
      accountId,
      status: "PENDING",
      cancelledAt: null,
    },
    select: {
      id: true,
      payload: true,
      createdByUserId: true,
    },
  });

  const now = new Date();
  let cancelled = 0;
  for (const schedule of schedules) {
    if (!payloadReferencesCategory(schedule.payload, categoryId)) continue;
    if (allowed.has(schedule.createdByUserId)) continue;

    await client.pendingTransactionSchedule.update({
      where: { id: schedule.id },
      data: { status: "CANCELLED", cancelledAt: now },
    });
    cancelled += 1;
  }
  return cancelled;
}

/** Permanent materialize failures caused by category lock / ACL / deletion. */
const PERMANENT_CATEGORY_SCHEDULE_ERRORS = new Set([
  "BAD_CATEGORY",
  "MANUAL_LOCKED",
  "CATEGORY_ACCESS_DENIED",
  "BAD_INV_CATEGORY",
  "MISSING_CATEGORY",
  "CATEGORY_TYPE_MISMATCH",
]);

function isPermanentCategoryScheduleError(err) {
  const msg = err && typeof err.message === "string" ? err.message : "";
  return PERMANENT_CATEGORY_SCHEDULE_ERRORS.has(msg);
}

module.exports = {
  payloadReferencesCategory,
  countPendingSchedulesForCategory,
  cancelPendingSchedulesForCategoryDeniedCreators,
  isPermanentCategoryScheduleError,
  PERMANENT_CATEGORY_SCHEDULE_ERRORS,
};
