const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  canConfigureCategoryMemberAccess,
  isMasterOwnedCategory,
  reassignCategoriesCreatedByFormerOwner,
} = require("../src/services/categoryMemberAccess");

const ALICE = "user-alice";
const BOB = "user-bob";
const ACCOUNT = "acct-shared";

function seedCategory(createdByUserId) {
  return {
    id: "cat-food",
    internalKey: null,
    lockedForManualEntry: false,
    createdByUserId,
    memberAccessRestricted: false,
  };
}

describe("ownership transfer category ACL", () => {
  it("treats seed categories stamped with the primary owner as master-owned", () => {
    const cat = seedCategory(ALICE);
    assert.equal(isMasterOwnedCategory(cat, ALICE), true);
    assert.equal(
      canConfigureCategoryMemberAccess({
        isPersonal: false,
        category: cat,
        primaryOwnerUserId: ALICE,
        userId: ALICE,
      }),
      true
    );
    assert.equal(
      canConfigureCategoryMemberAccess({
        isPersonal: false,
        category: cat,
        primaryOwnerUserId: ALICE,
        userId: BOB,
      }),
      false
    );
  });

  it("without reassignment, demoted former owner keeps lock-admin and new OWNER cannot configure", () => {
    // After transfer: Bob is OWNER; Food still has createdByUserId=Alice
    const cat = seedCategory(ALICE);
    assert.equal(isMasterOwnedCategory(cat, BOB), false);
    assert.equal(
      canConfigureCategoryMemberAccess({
        isPersonal: false,
        category: cat,
        primaryOwnerUserId: BOB,
        userId: ALICE,
      }),
      true,
      "former owner retains configure rights via creator match"
    );
    assert.equal(
      canConfigureCategoryMemberAccess({
        isPersonal: false,
        category: cat,
        primaryOwnerUserId: BOB,
        userId: BOB,
      }),
      false,
      "new OWNER cannot configure seed categories still stamped with former owner"
    );
  });

  it("after reassignment, only the new primary owner can configure former master categories", () => {
    const cat = seedCategory(BOB);
    assert.equal(isMasterOwnedCategory(cat, BOB), true);
    assert.equal(
      canConfigureCategoryMemberAccess({
        isPersonal: false,
        category: cat,
        primaryOwnerUserId: BOB,
        userId: BOB,
      }),
      true
    );
    assert.equal(
      canConfigureCategoryMemberAccess({
        isPersonal: false,
        category: cat,
        primaryOwnerUserId: BOB,
        userId: ALICE,
      }),
      false
    );
  });

  it("reassignCategoriesCreatedByFormerOwner updates creator ids for the account", async () => {
    const calls = [];
    const client = {
      category: {
        async updateMany(args) {
          calls.push(args);
          return { count: 3 };
        },
      },
    };

    const result = await reassignCategoriesCreatedByFormerOwner(client, {
      accountId: ACCOUNT,
      fromUserId: ALICE,
      toUserId: BOB,
    });

    assert.equal(result.count, 3);
    assert.deepEqual(calls, [
      {
        where: { accountId: ACCOUNT, createdByUserId: ALICE },
        data: { createdByUserId: BOB },
      },
    ]);
  });

  it("reassignCategoriesCreatedByFormerOwner is a no-op for identical or missing ids", async () => {
    let called = false;
    const client = {
      category: {
        async updateMany() {
          called = true;
          return { count: 1 };
        },
      },
    };

    assert.deepEqual(
      await reassignCategoriesCreatedByFormerOwner(client, {
        accountId: ACCOUNT,
        fromUserId: ALICE,
        toUserId: ALICE,
      }),
      { count: 0 }
    );
    assert.deepEqual(
      await reassignCategoriesCreatedByFormerOwner(client, {
        accountId: "",
        fromUserId: ALICE,
        toUserId: BOB,
      }),
      { count: 0 }
    );
    assert.equal(called, false);
  });

  it("does not reassign member-created categories belonging to a third user", async () => {
    const calls = [];
    const client = {
      category: {
        async updateMany(args) {
          calls.push(args);
          return { count: 1 };
        },
      },
    };

    await reassignCategoriesCreatedByFormerOwner(client, {
      accountId: ACCOUNT,
      fromUserId: ALICE,
      toUserId: BOB,
    });

    // Only Alice's creator stamp is targeted; Charlie's member categories stay put.
    assert.equal(calls[0].where.createdByUserId, ALICE);
    assert.notEqual(calls[0].where.createdByUserId, "user-charlie");
  });
});
