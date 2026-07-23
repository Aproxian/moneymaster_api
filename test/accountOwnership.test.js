const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OwnerCannotLeaveError,
  deleteNonOwnerMembership,
} = require("../src/lib/accountOwnership");

test("leave deletes only a membership that is still non-owner", async () => {
  let where;
  const tx = {
    accountMember: {
      deleteMany: async (query) => {
        where = query.where;
        return { count: 1 };
      },
    },
  };

  await deleteNonOwnerMembership(tx, "user-1", "account-1");

  assert.deepEqual(where, {
    userId: "user-1",
    accountId: "account-1",
    role: { not: "OWNER" },
  });
});

test("leave fails when ownership changed before the membership write", async () => {
  const tx = {
    accountMember: {
      deleteMany: async () => ({ count: 0 }),
    },
  };

  await assert.rejects(
    deleteNonOwnerMembership(tx, "user-1", "account-1"),
    OwnerCannotLeaveError
  );
});
