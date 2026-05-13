const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cancelScheduleIfCreatorNoLongerMember,
} = require("../src/services/processPendingSchedules");

function makeTx({ creatorIsMember }) {
  const calls = {
    scheduleUpdate: null,
    auditCreate: null,
  };
  return {
    calls,
    accountMember: {
      findUnique: async () => (creatorIsMember ? { userId: "user-1" } : null),
    },
    pendingTransactionSchedule: {
      update: async (args) => {
        calls.scheduleUpdate = args;
        return {};
      },
    },
    auditLog: {
      create: async (args) => {
        calls.auditCreate = args;
        return {};
      },
    },
  };
}

test("keeps a due schedule when its creator is still an account member", async () => {
  const tx = makeTx({ creatorIsMember: true });
  const cancelled = await cancelScheduleIfCreatorNoLongerMember(
    tx,
    { id: "schedule-1", accountId: "account-1", createdByUserId: "user-1" },
    new Date("2026-05-13T11:00:00.000Z")
  );

  assert.equal(cancelled, false);
  assert.equal(tx.calls.scheduleUpdate, null);
  assert.equal(tx.calls.auditCreate, null);
});

test("cancels a due schedule whose creator was removed from the account", async () => {
  const tx = makeTx({ creatorIsMember: false });
  const now = new Date("2026-05-13T11:00:00.000Z");
  const cancelled = await cancelScheduleIfCreatorNoLongerMember(
    tx,
    { id: "schedule-1", accountId: "account-1", createdByUserId: "user-1" },
    now
  );

  assert.equal(cancelled, true);
  assert.deepEqual(tx.calls.scheduleUpdate, {
    where: { id: "schedule-1" },
    data: { status: "CANCELLED", cancelledAt: now },
  });
  assert.equal(tx.calls.auditCreate.data.userId, null);
  assert.equal(tx.calls.auditCreate.data.meta.reason, "SCHEDULE_CREATOR_REMOVED");
  assert.equal(tx.calls.auditCreate.data.meta.createdByUserId, "user-1");
});
