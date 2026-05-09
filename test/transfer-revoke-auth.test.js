const assert = require("node:assert/strict");
const { test } = require("node:test");

const { userCanRevokeTransferGroup } = require("../src/routes/transactions");

test("userCanRevokeTransferGroup denies when user is missing any group account membership", async () => {
  const tx = {
    transaction: {
      findMany: async () => [
        { accountId: "source-account" },
        { accountId: "destination-account" },
      ],
    },
    accountMember: {
      count: async ({ where }) => {
        assert.equal(where.userId, "user-1");
        assert.deepEqual(where.accountId.in, [
          "source-account",
          "destination-account",
        ]);
        return 1;
      },
    },
  };

  assert.equal(
    await userCanRevokeTransferGroup(tx, "transfer-group-1", "user-1"),
    false
  );
});

test("userCanRevokeTransferGroup allows users who belong to every group account", async () => {
  const tx = {
    transaction: {
      findMany: async () => [
        { accountId: "source-account" },
        { accountId: "source-account" },
        { accountId: "destination-account" },
      ],
    },
    accountMember: {
      count: async ({ where }) => {
        assert.deepEqual(where.accountId.in, [
          "source-account",
          "destination-account",
        ]);
        return 2;
      },
    },
  };

  assert.equal(
    await userCanRevokeTransferGroup(tx, "transfer-group-1", "user-1"),
    true
  );
});

test("userCanRevokeTransferGroup denies empty transfer groups", async () => {
  const tx = {
    transaction: {
      findMany: async () => [],
    },
    accountMember: {
      count: async () => {
        throw new Error("membership lookup should not run for empty groups");
      },
    },
  };

  assert.equal(
    await userCanRevokeTransferGroup(tx, "missing-transfer-group", "user-1"),
    false
  );
});
