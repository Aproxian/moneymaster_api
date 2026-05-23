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

module.exports = {
  countPendingSchedulesForCategory,
  payloadReferencesCategory,
};
