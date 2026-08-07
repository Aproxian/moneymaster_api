const assert = require("node:assert/strict");
const test = require("node:test");

const {
  countPendingSchedulesForCategory,
  payloadReferencesCategory,
  cancelPendingSchedulesForCategoryDeniedCreators,
  isPermanentCategoryScheduleError,
} = require("../src/lib/schedulePayloads");

test("payloadReferencesCategory only matches object payload categoryId", () => {
  assert.equal(payloadReferencesCategory({ categoryId: "cat_1" }, "cat_1"), true);
  assert.equal(payloadReferencesCategory({ categoryId: "cat_2" }, "cat_1"), false);
  assert.equal(payloadReferencesCategory({ categoryId: 1 }, "1"), false);
  assert.equal(payloadReferencesCategory(null, "cat_1"), false);
  assert.equal(payloadReferencesCategory(["cat_1"], "cat_1"), false);
});

test("countPendingSchedulesForCategory filters by account pending schedules and payload", async () => {
  const calls = [];
  const prisma = {
    pendingTransactionSchedule: {
      async findMany(args) {
        calls.push(args);
        return [
          { payload: { categoryId: "cat_1" } },
          { payload: { categoryId: "cat_1", tab: "expense" } },
          { payload: { categoryId: "cat_2" } },
          { payload: null },
        ];
      },
    },
  };

  const count = await countPendingSchedulesForCategory(prisma, "acct_1", "cat_1");

  assert.equal(count, 2);
  assert.deepEqual(calls, [
    {
      where: {
        accountId: "acct_1",
        status: "PENDING",
        cancelledAt: null,
      },
      select: {
        payload: true,
      },
    },
  ]);
});

test("cancelPendingSchedulesForCategoryDeniedCreators cancels only denied creators for that category", async () => {
  const updates = [];
  const client = {
    pendingTransactionSchedule: {
      async findMany() {
        return [
          {
            id: "sch_keep_owner",
            createdByUserId: "owner_1",
            payload: { categoryId: "cat_1", tab: "expense" },
          },
          {
            id: "sch_cancel_member",
            createdByUserId: "member_1",
            payload: { categoryId: "cat_1", tab: "income" },
          },
          {
            id: "sch_other_category",
            createdByUserId: "member_1",
            payload: { categoryId: "cat_2", tab: "expense" },
          },
          {
            id: "sch_allowed_member",
            createdByUserId: "member_2",
            payload: { categoryId: "cat_1", tab: "invest" },
          },
        ];
      },
      async update({ where, data }) {
        updates.push({ where, data });
        return { id: where.id };
      },
    },
  };

  const cancelled = await cancelPendingSchedulesForCategoryDeniedCreators(client, {
    accountId: "acct_1",
    categoryId: "cat_1",
    allowedUserIds: ["owner_1", "member_2"],
  });

  assert.equal(cancelled, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].where.id, "sch_cancel_member");
  assert.equal(updates[0].data.status, "CANCELLED");
  assert.ok(updates[0].data.cancelledAt instanceof Date);
});

test("isPermanentCategoryScheduleError matches lock/ACL materialize failures only", () => {
  assert.equal(isPermanentCategoryScheduleError(new Error("BAD_CATEGORY")), true);
  assert.equal(isPermanentCategoryScheduleError(new Error("MANUAL_LOCKED")), true);
  assert.equal(isPermanentCategoryScheduleError(new Error("CATEGORY_ACCESS_DENIED")), true);
  assert.equal(isPermanentCategoryScheduleError(new Error("BAD_INV_CATEGORY")), true);
  assert.equal(isPermanentCategoryScheduleError(new Error("MISSING_CATEGORY")), true);
  assert.equal(isPermanentCategoryScheduleError(new Error("CATEGORY_TYPE_MISMATCH")), true);
  assert.equal(
    isPermanentCategoryScheduleError(
      new Error("This account is set to prevent cash balance from going below zero")
    ),
    false
  );
  assert.equal(isPermanentCategoryScheduleError(new Error("WALLET_REQUIRED")), false);
  assert.equal(isPermanentCategoryScheduleError(new Error("INVESTING_OFF")), false);
  assert.equal(isPermanentCategoryScheduleError(null), false);
});
