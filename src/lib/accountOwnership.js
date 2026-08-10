class MembershipRemoveConflictError extends Error {
  /**
   * @param {"role_changed" | "last_owner"} reason
   */
  constructor(reason) {
    super(
      reason === "last_owner"
        ? "Cannot remove the only owner of this account"
        : "Member role changed; retry the removal"
    );
    this.name = "MembershipRemoveConflictError";
    this.reason = reason;
  }
}

/**
 * Delete a membership at write time with role predicates so concurrent ownership
 * transfer cannot remove the newly promoted OWNER after a stale pre-check.
 *
 * - ADMIN may only remove MEMBER.
 * - OWNER may remove MEMBER/ADMIN unconditionally (role still non-OWNER at write).
 * - OWNER may remove another OWNER only when at least one OWNER would remain.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{
 *   accountId: string;
 *   memberUserId: string;
 *   requesterRole: string;
 *   observedTargetRole: string;
 * }} args
 */
async function deleteMembershipForRemoval(
  tx,
  { accountId, memberUserId, requesterRole, observedTargetRole }
) {
  if (requesterRole === "ADMIN") {
    const deleted = await tx.accountMember.deleteMany({
      where: {
        userId: memberUserId,
        accountId,
        role: "MEMBER",
      },
    });
    if (deleted.count !== 1) {
      throw new MembershipRemoveConflictError("role_changed");
    }
    return;
  }

  if (observedTargetRole === "OWNER") {
    const deleted = await tx.accountMember.deleteMany({
      where: {
        userId: memberUserId,
        accountId,
        role: "OWNER",
      },
    });
    if (deleted.count !== 1) {
      throw new MembershipRemoveConflictError("role_changed");
    }
    const ownersLeft = await tx.accountMember.count({
      where: { accountId, role: "OWNER" },
    });
    if (ownersLeft < 1) {
      throw new MembershipRemoveConflictError("last_owner");
    }
    return;
  }

  // Pre-check saw a non-owner. Refuse the write if they were promoted to OWNER
  // (ownership transfer race) before this delete committed.
  const deleted = await tx.accountMember.deleteMany({
    where: {
      userId: memberUserId,
      accountId,
      role: { not: "OWNER" },
    },
  });
  if (deleted.count !== 1) {
    throw new MembershipRemoveConflictError("role_changed");
  }
}

module.exports = {
  MembershipRemoveConflictError,
  deleteMembershipForRemoval,
};
