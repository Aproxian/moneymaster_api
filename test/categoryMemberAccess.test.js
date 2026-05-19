const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canToggleCategoryManualLock,
} = require("../src/services/categoryMemberAccess");

test("personal account user can toggle custom category manual lock", () => {
  assert.equal(
    canToggleCategoryManualLock({
      isPersonal: true,
      category: { internalKey: null, createdByUserId: "user-1" },
      primaryOwnerUserId: null,
      userId: "user-1",
    }),
    true
  );
});

test("only primary owner can toggle master-owned shared category lock", () => {
  const category = { internalKey: null, createdByUserId: "owner-1" };

  assert.equal(
    canToggleCategoryManualLock({
      isPersonal: false,
      category,
      primaryOwnerUserId: "owner-1",
      userId: "owner-1",
    }),
    true
  );
  assert.equal(
    canToggleCategoryManualLock({
      isPersonal: false,
      category,
      primaryOwnerUserId: "owner-1",
      userId: "member-1",
    }),
    false
  );
});

test("only creator can toggle member-created shared category lock", () => {
  const category = { internalKey: null, createdByUserId: "member-1" };

  assert.equal(
    canToggleCategoryManualLock({
      isPersonal: false,
      category,
      primaryOwnerUserId: "owner-1",
      userId: "member-1",
    }),
    true
  );
  assert.equal(
    canToggleCategoryManualLock({
      isPersonal: false,
      category,
      primaryOwnerUserId: "owner-1",
      userId: "member-2",
    }),
    false
  );
});

test("system categories cannot toggle manual lock", () => {
  assert.equal(
    canToggleCategoryManualLock({
      isPersonal: true,
      category: { internalKey: "TRANSFER_SEND", createdByUserId: "user-1" },
      primaryOwnerUserId: null,
      userId: "user-1",
    }),
    false
  );
});
