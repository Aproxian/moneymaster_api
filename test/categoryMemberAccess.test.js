const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  clearMemberCategoryAccessForAccount,
} = require("../src/services/categoryMemberAccess");

test("clearMemberCategoryAccessForAccount deletes grants only for categories in the account", async () => {
  const calls = [];
  const client = {
    category: {
      async findMany(args) {
        calls.push(["category.findMany", args]);
        return [{ id: "cat-1" }, { id: "cat-2" }];
      },
    },
    categoryMemberAccess: {
      async deleteMany(args) {
        calls.push(["categoryMemberAccess.deleteMany", args]);
        return { count: 2 };
      },
    },
  };

  const result = await clearMemberCategoryAccessForAccount(client, "account-1", "user-1");

  assert.deepEqual(result, { count: 2 });
  assert.deepEqual(calls, [
    [
      "category.findMany",
      {
        where: { accountId: "account-1" },
        select: { id: true },
      },
    ],
    [
      "categoryMemberAccess.deleteMany",
      {
        where: {
          userId: "user-1",
          categoryId: { in: ["cat-1", "cat-2"] },
        },
      },
    ],
  ]);
});

test("clearMemberCategoryAccessForAccount skips delete when the account has no categories", async () => {
  let deleteCalled = false;
  const client = {
    category: {
      async findMany() {
        return [];
      },
    },
    categoryMemberAccess: {
      async deleteMany() {
        deleteCalled = true;
      },
    },
  };

  const result = await clearMemberCategoryAccessForAccount(client, "account-1", "user-1");

  assert.deepEqual(result, { count: 0 });
  assert.equal(deleteCalled, false);
});
