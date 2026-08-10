const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MembershipRemoveConflictError,
  deleteMembershipForRemoval,
} = require("../src/lib/accountOwnership");

function makeTx({ deleteCount, ownersLeftAfter = 1 }) {
  const calls = { deleteWhere: null };
  return {
    calls,
    accountMember: {
      deleteMany: async (query) => {
        calls.deleteWhere = query.where;
        return { count: deleteCount };
      },
      count: async () => ownersLeftAfter,
    },
  };
}

test("OWNER removing a MEMBER uses non-OWNER predicate at write time", async () => {
  const tx = makeTx({ deleteCount: 1 });
  await deleteMembershipForRemoval(tx, {
    accountId: "acct-1",
    memberUserId: "bob",
    requesterRole: "OWNER",
    observedTargetRole: "MEMBER",
  });
  assert.deepEqual(tx.calls.deleteWhere, {
    userId: "bob",
    accountId: "acct-1",
    role: { not: "OWNER" },
  });
});

test("remove fails when transfer promoted the target to OWNER before delete", async () => {
  const tx = makeTx({ deleteCount: 0 });
  await assert.rejects(
    () =>
      deleteMembershipForRemoval(tx, {
        accountId: "acct-1",
        memberUserId: "bob",
        requesterRole: "OWNER",
        observedTargetRole: "MEMBER",
      }),
    (err) =>
      err instanceof MembershipRemoveConflictError && err.reason === "role_changed"
  );
});

test("ADMIN remove only matches MEMBER role at write time", async () => {
  const tx = makeTx({ deleteCount: 1 });
  await deleteMembershipForRemoval(tx, {
    accountId: "acct-1",
    memberUserId: "bob",
    requesterRole: "ADMIN",
    observedTargetRole: "MEMBER",
  });
  assert.deepEqual(tx.calls.deleteWhere, {
    userId: "bob",
    accountId: "acct-1",
    role: "MEMBER",
  });
});

test("ADMIN remove fails if target became OWNER before delete", async () => {
  const tx = makeTx({ deleteCount: 0 });
  await assert.rejects(
    () =>
      deleteMembershipForRemoval(tx, {
        accountId: "acct-1",
        memberUserId: "bob",
        requesterRole: "ADMIN",
        observedTargetRole: "MEMBER",
      }),
    (err) =>
      err instanceof MembershipRemoveConflictError && err.reason === "role_changed"
  );
});

test("OWNER removing a co-OWNER rolls back when it would leave zero owners", async () => {
  const tx = makeTx({ deleteCount: 1, ownersLeftAfter: 0 });
  await assert.rejects(
    () =>
      deleteMembershipForRemoval(tx, {
        accountId: "acct-1",
        memberUserId: "bob",
        requesterRole: "OWNER",
        observedTargetRole: "OWNER",
      }),
    (err) =>
      err instanceof MembershipRemoveConflictError && err.reason === "last_owner"
  );
});

test("OWNER removing a co-OWNER succeeds when another OWNER remains", async () => {
  const tx = makeTx({ deleteCount: 1, ownersLeftAfter: 1 });
  await deleteMembershipForRemoval(tx, {
    accountId: "acct-1",
    memberUserId: "bob",
    requesterRole: "OWNER",
    observedTargetRole: "OWNER",
  });
  assert.deepEqual(tx.calls.deleteWhere, {
    userId: "bob",
    accountId: "acct-1",
    role: "OWNER",
  });
});
