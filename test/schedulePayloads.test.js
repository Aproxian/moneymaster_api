const assert = require("node:assert/strict");
const test = require("node:test");

const {
  countPendingSchedulesForCategory,
  payloadReferencesCategory,
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
