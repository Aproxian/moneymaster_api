const assert = require("node:assert/strict");
const test = require("node:test");

const {
  planMembershipRemovalOnUserDelete,
  removeMembershipOnUserDelete,
} = require("../src/lib/userDeleteMembership");

const t0 = new Date("2026-01-01T00:00:00.000Z");
const t1 = new Date("2026-01-02T00:00:00.000Z");
const t2 = new Date("2026-01-03T00:00:00.000Z");

test("last remaining member soft-deletes the account", () => {
  assert.deepEqual(
    planMembershipRemovalOnUserDelete("alice", [
      { userId: "alice", role: "OWNER", joinedAt: t0 },
    ]),
    { type: "delete_account_and_self" }
  );
});

test("owner leaving a two-person book promotes the remaining member", () => {
  assert.deepEqual(
    planMembershipRemovalOnUserDelete("alice", [
      { userId: "alice", role: "OWNER", joinedAt: t0 },
      { userId: "bob", role: "MEMBER", joinedAt: t1 },
    ]),
    { type: "promote_and_leave", successorUserId: "bob" }
  );
});

test("member leaving while the owner is still present does not promote", () => {
  assert.deepEqual(
    planMembershipRemovalOnUserDelete("bob", [
      { userId: "alice", role: "OWNER", joinedAt: t0 },
      { userId: "bob", role: "MEMBER", joinedAt: t1 },
    ]),
    { type: "leave" }
  );
});

test("serialized owner-then-member deletes soft-delete the book (two-person race)", () => {
  const start = [
    { userId: "alice", role: "OWNER", joinedAt: t0 },
    { userId: "bob", role: "MEMBER", joinedAt: t1 },
  ];

  const ownerPlan = planMembershipRemovalOnUserDelete("alice", start);
  assert.deepEqual(ownerPlan, { type: "promote_and_leave", successorUserId: "bob" });

  // After Alice's transaction commits, Bob is the only remaining member.
  const afterOwner = [{ userId: "bob", role: "OWNER", joinedAt: t1 }];
  assert.deepEqual(planMembershipRemovalOnUserDelete("bob", afterOwner), {
    type: "delete_account_and_self",
  });
});

test("serialized member-then-owner deletes also soft-delete the book", () => {
  const start = [
    { userId: "alice", role: "OWNER", joinedAt: t0 },
    { userId: "bob", role: "MEMBER", joinedAt: t1 },
  ];

  assert.deepEqual(planMembershipRemovalOnUserDelete("bob", start), { type: "leave" });

  const afterMember = [{ userId: "alice", role: "OWNER", joinedAt: t0 }];
  assert.deepEqual(planMembershipRemovalOnUserDelete("alice", afterMember), {
    type: "delete_account_and_self",
  });
});

test("owner leaving a three-person book promotes the earliest remaining member", () => {
  assert.deepEqual(
    planMembershipRemovalOnUserDelete("alice", [
      { userId: "alice", role: "OWNER", joinedAt: t0 },
      { userId: "charlie", role: "MEMBER", joinedAt: t2 },
      { userId: "bob", role: "MEMBER", joinedAt: t1 },
    ]),
    { type: "promote_and_leave", successorUserId: "bob" }
  );
});

test("stale membership after a concurrent leave is a no-op", () => {
  assert.deepEqual(
    planMembershipRemovalOnUserDelete("bob", [
      { userId: "alice", role: "OWNER", joinedAt: t0 },
    ]),
    { type: "noop" }
  );
});

function sqlText(strings) {
  return Array.isArray(strings) ? strings.join("?") : String(strings);
}

test("executor locks account + members before promoting and deleting", async () => {
  const calls = [];
  const now = new Date("2026-08-23T11:00:00.000Z");
  const tx = {
    $queryRaw: async (strings) => {
      const sql = sqlText(strings);
      calls.push(sql);
      if (sql.includes("FROM Account ")) return [{ id: "acc-1" }];
      if (sql.includes("FROM AccountMember")) {
        return [
          { userId: "alice", role: "OWNER", joinedAt: t0 },
          { userId: "bob", role: "MEMBER", joinedAt: t1 },
        ];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    account: {
      update: async (args) => {
        calls.push(["account.update", args]);
      },
    },
    accountMember: {
      update: async (args) => {
        calls.push(["accountMember.update", args]);
      },
      delete: async (args) => {
        calls.push(["accountMember.delete", args]);
      },
    },
  };

  const plan = await removeMembershipOnUserDelete(tx, {
    userId: "alice",
    accountId: "acc-1",
    now,
  });

  assert.deepEqual(plan, { type: "promote_and_leave", successorUserId: "bob" });
  assert.match(calls[0], /FROM Account/);
  assert.match(calls[0], /FOR UPDATE/);
  assert.match(calls[1], /FROM AccountMember/);
  assert.match(calls[1], /FOR UPDATE/);
  assert.deepEqual(calls[2], [
    "accountMember.update",
    {
      where: { userId_accountId: { userId: "bob", accountId: "acc-1" } },
      data: { role: "OWNER" },
    },
  ]);
  assert.deepEqual(calls[3], [
    "accountMember.delete",
    { where: { userId_accountId: { userId: "alice", accountId: "acc-1" } } },
  ]);
});

test("executor soft-deletes the account when the locking read shows no other members", async () => {
  const now = new Date("2026-08-23T11:00:00.000Z");
  let accountUpdate;
  const tx = {
    $queryRaw: async (strings) => {
      const sql = sqlText(strings);
      if (sql.includes("FROM Account ")) return [{ id: "acc-1" }];
      if (sql.includes("FROM AccountMember")) {
        return [{ userId: "bob", role: "OWNER", joinedAt: t1 }];
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    account: {
      update: async (args) => {
        accountUpdate = args;
      },
    },
    accountMember: {
      update: async () => {
        throw new Error("should not promote when last member");
      },
      delete: async () => ({}),
    },
  };

  const plan = await removeMembershipOnUserDelete(tx, {
    userId: "bob",
    accountId: "acc-1",
    now,
  });

  assert.deepEqual(plan, { type: "delete_account_and_self" });
  assert.deepEqual(accountUpdate, {
    where: { id: "acc-1" },
    data: { deletedAt: now },
  });
});
