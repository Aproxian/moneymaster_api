const { TRANSFER_SEND, TRANSFER_RECEIVE } = require("../lib/transferCategoryKeys");
const { CASH_OUT_INVESTMENT } = require("../lib/investmentCategoryKeys");
const {
  cancelPendingSchedulesForCategoryDeniedCreators,
} = require("../lib/schedulePayloads");

function isTransferOrCashoutInternalKey(internalKey) {
  if (!internalKey) return false;
  if (internalKey === TRANSFER_SEND || internalKey === TRANSFER_RECEIVE) return true;
  if (internalKey === CASH_OUT_INVESTMENT) return true;
  return false;
}

/**
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 * @param {string} accountId
 */
async function getPrimaryOwnerUserId(client, accountId) {
  const row = await client.accountMember.findFirst({
    where: { accountId, role: "OWNER" },
    orderBy: { joinedAt: "asc" },
    select: { userId: true },
  });
  return row?.userId ?? null;
}

/**
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 */
async function accountIsPersonalForUser(client, userId, accountId) {
  const u = await client.user.findUnique({
    where: { id: userId },
    select: { personalAccountId: true },
  });
  return u?.personalAccountId != null && u.personalAccountId === accountId;
}

function isMasterOwnedCategory(category, primaryOwnerUserId) {
  if (!primaryOwnerUserId) return category.createdByUserId == null;
  return category.createdByUserId == null || category.createdByUserId === primaryOwnerUserId;
}

/**
 * Who may open/edit the member-access UI (non-personal books only).
 */
function canConfigureCategoryMemberAccess({ isPersonal, category, primaryOwnerUserId, userId }) {
  if (isPersonal || !category) return false;
  if (category.lockedForManualEntry) return false;
  if (isTransferOrCashoutInternalKey(category.internalKey)) return false;
  if (isMasterOwnedCategory(category, primaryOwnerUserId)) {
    return userId === primaryOwnerUserId;
  }
  return category.createdByUserId === userId;
}

function computeManualEntryAllowedForMe({
  category,
  isPersonal,
  userId,
  primaryOwnerUserId,
  hasExplicitGrant,
}) {
  if (!category) return false;
  if (category.lockedForManualEntry) return false;
  if (category.type !== "INVESTMENT" && category.internalKey) return false;
  if (isPersonal) return true;
  if (!category.memberAccessRestricted) return true;
  if (primaryOwnerUserId && userId === primaryOwnerUserId) return true;
  return Boolean(hasExplicitGrant);
}

/**
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 */
async function assertCategoryManualMemberAccess(client, { accountId, userId, category }) {
  if (!category) {
    const err = new Error("BAD_CATEGORY");
    err.statusCode = 400;
    throw err;
  }
  if (category.lockedForManualEntry) {
    const err = new Error("MANUAL_LOCKED");
    err.statusCode = 400;
    throw err;
  }
  if (category.type !== "INVESTMENT" && category.internalKey) {
    const err = new Error("SYS_CATEGORY");
    err.statusCode = 400;
    throw err;
  }

  const isPersonal = await accountIsPersonalForUser(client, userId, accountId);
  if (isPersonal) return;
  if (!category.memberAccessRestricted) return;

  const primaryOwnerUserId = await getPrimaryOwnerUserId(client, accountId);
  if (primaryOwnerUserId && userId === primaryOwnerUserId) return;

  const row = await client.categoryMemberAccess.findUnique({
    where: { categoryId_userId: { categoryId: category.id, userId } },
  });
  if (!row) {
    const err = new Error("CATEGORY_ACCESS_DENIED");
    err.statusCode = 403;
    throw err;
  }
}

/**
 * When a new member joins, grant access to restricted categories that default-unlock new users.
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 */
async function syncNewMemberCategoryAccess(client, accountId, newUserId) {
  const cats = await client.category.findMany({
    where: {
      accountId,
      deletedAt: null,
      memberAccessRestricted: true,
      newMembersLockedByDefault: false,
    },
    select: { id: true },
  });
  for (const c of cats) {
    await client.categoryMemberAccess.upsert({
      where: { categoryId_userId: { categoryId: c.id, userId: newUserId } },
      create: { categoryId: c.id, userId: newUserId },
      update: {},
    });
  }
}

/**
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 */
async function getCategoryMemberAccessState(client, { accountId, categoryId }) {
  const category = await client.category.findFirst({
    where: { id: categoryId, accountId, deletedAt: null },
    select: {
      id: true,
      internalKey: true,
      lockedForManualEntry: true,
      createdByUserId: true,
      memberAccessRestricted: true,
      newMembersLockedByDefault: true,
    },
  });
  if (!category) return null;

  const primaryOwnerUserId = await getPrimaryOwnerUserId(client, accountId);
  const memberRows = await client.accountMember.findMany({
    where: { accountId },
    select: { userId: true },
  });
  const allMemberIds = memberRows.map((m) => m.userId);

  if (!category.memberAccessRestricted) {
    return {
      category,
      primaryOwnerUserId,
      memberAccessRestricted: false,
      newMembersLockedByDefault: category.newMembersLockedByDefault,
      allowedUserIds: allMemberIds,
    };
  }

  const grants = await client.categoryMemberAccess.findMany({
    where: { categoryId },
    select: { userId: true },
  });
  const allowed = new Set(grants.map((g) => g.userId));
  if (primaryOwnerUserId) allowed.add(primaryOwnerUserId);

  return {
    category,
    primaryOwnerUserId,
    memberAccessRestricted: category.memberAccessRestricted,
    newMembersLockedByDefault: category.newMembersLockedByDefault,
    allowedUserIds: [...allowed],
  };
}

/**
 * @param {import('@prisma/client').PrismaClient | import('@prisma/client').Prisma.TransactionClient} client
 */
async function setCategoryMemberAccess(client, { accountId, categoryId, allowedUserIds, memberAccessRestricted, newMembersLockedByDefault }) {
  const memberIds = new Set(
    (
      await client.accountMember.findMany({
        where: { accountId },
        select: { userId: true },
      })
    ).map((m) => m.userId)
  );

  const primaryOwnerUserId = await getPrimaryOwnerUserId(client, accountId);
  const merged = new Set(allowedUserIds.filter((id) => memberIds.has(id)));
  if (primaryOwnerUserId) merged.add(primaryOwnerUserId);

  await client.$transaction(async (tx) => {
    await tx.category.update({
      where: { id: categoryId },
      data: {
        memberAccessRestricted,
        newMembersLockedByDefault: memberAccessRestricted ? newMembersLockedByDefault : false,
      },
    });

    await tx.categoryMemberAccess.deleteMany({ where: { categoryId } });

    if (memberAccessRestricted && merged.size > 0) {
      await tx.categoryMemberAccess.createMany({
        data: [...merged].map((userId) => ({ categoryId, userId })),
        skipDuplicates: true,
      });
    }

    // Creators who lose category access would otherwise leave due PENDING rows
    // that fail materialize with CATEGORY_ACCESS_DENIED every processor pass.
    if (memberAccessRestricted) {
      await cancelPendingSchedulesForCategoryDeniedCreators(tx, {
        accountId,
        categoryId,
        allowedUserIds: merged,
      });
    }
  });
}

/** UI sort: primary owner first, then OWNER / ADMIN / MEMBER, then joinedAt. */
function sortMembersForLockUi(members) {
  const rows = members.map((m) => ({
    ...m,
    jt: new Date(m.joinedAt).getTime(),
  }));
  const owners = rows.filter((m) => m.role === "OWNER").sort((a, b) => a.jt - b.jt);
  const primary = owners[0];
  const primaryId = primary?.user?.id ?? null;
  const rest = rows
    .filter((m) => m.user.id !== primaryId)
    .sort((a, b) => {
      const ro = (r) => (r === "OWNER" ? 0 : r === "ADMIN" ? 1 : 2);
      const d = ro(a.role) - ro(b.role);
      if (d !== 0) return d;
      return a.jt - b.jt;
    });
  return primary ? [primary, ...rest] : rest;
}

module.exports = {
  getPrimaryOwnerUserId,
  accountIsPersonalForUser,
  isMasterOwnedCategory,
  canConfigureCategoryMemberAccess,
  computeManualEntryAllowedForMe,
  assertCategoryManualMemberAccess,
  syncNewMemberCategoryAccess,
  getCategoryMemberAccessState,
  setCategoryMemberAccess,
  sortMembersForLockUi,
  isTransferOrCashoutInternalKey,
};
