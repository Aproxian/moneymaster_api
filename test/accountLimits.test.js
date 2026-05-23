const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ACCOUNT_LIMIT_REACHED_MESSAGE,
  AccountLimitError,
  assertCanAddActiveAccountMembership,
  isAccountLimitError,
} = require("../src/lib/accountLimits");

function fakeTx(count) {
  const calls = [];
  return {
    calls,
    async $queryRaw(strings, userId) {
      calls.push({ op: "lock", sql: strings.join("?"), userId });
      return [{ id: userId }];
    },
    accountMember: {
      async count(args) {
        calls.push({ op: "count", args });
        return count;
      },
    },
  };
}

test("assertCanAddActiveAccountMembership locks the user before counting", async () => {
  const tx = fakeTx(9);

  await assertCanAddActiveAccountMembership(tx, "user_1");

  assert.deepEqual(tx.calls, [
    {
      op: "lock",
      sql: "SELECT id FROM `User` WHERE id = ? FOR UPDATE",
      userId: "user_1",
    },
    {
      op: "count",
      args: {
        where: {
          userId: "user_1",
          account: { deletedAt: null },
        },
      },
    },
  ]);
});

test("assertCanAddActiveAccountMembership rejects users already at the cap", async () => {
  const tx = fakeTx(10);

  await assert.rejects(
    () => assertCanAddActiveAccountMembership(tx, "user_1"),
    (err) => {
      assert.equal(err instanceof AccountLimitError, true);
      assert.equal(isAccountLimitError(err), true);
      assert.equal(err.message, ACCOUNT_LIMIT_REACHED_MESSAGE);
      assert.equal(err.code, "ACCOUNT_LIMIT_REACHED");
      assert.equal(err.statusCode, 403);
      return true;
    }
  );
});

test("assertCanAddActiveAccountMembership supports route-specific errors", async () => {
  const tx = fakeTx(10);

  await assert.rejects(
    () =>
      assertCanAddActiveAccountMembership(tx, "user_1", {
        message: "Invitee is full",
        code: "INVITEE_ACCOUNT_LIMIT",
        statusCode: 409,
      }),
    (err) => {
      assert.equal(err.message, "Invitee is full");
      assert.equal(err.code, "INVITEE_ACCOUNT_LIMIT");
      assert.equal(err.statusCode, 409);
      return true;
    }
  );
});
