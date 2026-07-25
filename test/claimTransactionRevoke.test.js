const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AlreadyRevokedError,
  claimTransactionRevoke,
} = require("../src/lib/claimTransactionRevoke");

test("claims revoke only while revokedAt is still null", async () => {
  let where;
  let data;
  const tx = {
    transaction: {
      updateMany: async (query) => {
        where = query.where;
        data = query.data;
        return { count: 1 };
      },
    },
  };
  const revokedAt = new Date("2026-07-25T12:00:00.000Z");

  await claimTransactionRevoke(tx, {
    transactionId: "tx-1",
    accountId: "account-1",
    revokedAt,
  });

  assert.deepEqual(where, {
    id: "tx-1",
    accountId: "account-1",
    deletedAt: null,
    revokedAt: null,
  });
  assert.deepEqual(data, { revokedAt });
});

test("rejects when a concurrent revoke already claimed the row", async () => {
  const tx = {
    transaction: {
      updateMany: async () => ({ count: 0 }),
    },
  };

  await assert.rejects(
    claimTransactionRevoke(tx, {
      transactionId: "tx-1",
      accountId: "account-1",
      revokedAt: new Date(),
    }),
    AlreadyRevokedError
  );
});
