/**
 * Account succession when a user soft-deletes themselves (DELETE /me).
 *
 * Concurrent DELETE /me from two members of the same book can otherwise leave
 * the account with zero members (and deletedAt still null) or with only
 * MEMBER/ADMIN rows and no OWNER. Those books become unreachable / unadministrable.
 *
 * InnoDB REPEATABLE READ snapshots the first consistent read. Membership
 * decisions therefore use SELECT … FOR UPDATE (current reads) after locking
 * the Account row so concurrent deleters serialize and see committed state.
 */

/**
 * @typedef {{ userId: string, role: string, joinedAt: Date }} MemberRow
 * @typedef {{ type: "noop" }
 *   | { type: "delete_account_and_self" }
 *   | { type: "promote_and_leave", successorUserId: string }
 *   | { type: "leave" }} MembershipRemovalPlan
 */

/**
 * Decide how to remove `userId` given a current-read member snapshot.
 * @param {string} userId
 * @param {MemberRow[]} members
 * @returns {MembershipRemovalPlan}
 */
function planMembershipRemovalOnUserDelete(userId, members) {
  const me = members.find((m) => m.userId === userId);
  if (!me) return { type: "noop" };

  const others = members.filter((m) => m.userId !== userId);
  if (others.length === 0) {
    return { type: "delete_account_and_self" };
  }

  if (me.role === "OWNER") {
    const successor = [...others].sort(
      (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime()
    )[0];
    return { type: "promote_and_leave", successorUserId: successor.userId };
  }

  return { type: "leave" };
}

/**
 * @param {unknown} value
 * @returns {Date}
 */
function asDate(value) {
  if (value instanceof Date) return value;
  return new Date(value);
}

/**
 * Lock the account and current members, then apply succession + membership delete.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {{ userId: string, accountId: string, now: Date }} args
 */
async function removeMembershipOnUserDelete(tx, { userId, accountId, now }) {
  await tx.$queryRaw`SELECT id FROM Account WHERE id = ${accountId} FOR UPDATE`;

  const lockedMembers = await tx.$queryRaw`
    SELECT userId, role, joinedAt
    FROM AccountMember
    WHERE accountId = ${accountId}
    FOR UPDATE
  `;

  const members = (lockedMembers ?? []).map((row) => ({
    userId: row.userId,
    role: row.role,
    joinedAt: asDate(row.joinedAt),
  }));

  const plan = planMembershipRemovalOnUserDelete(userId, members);

  if (plan.type === "noop") return plan;

  if (plan.type === "delete_account_and_self") {
    await tx.account.update({
      where: { id: accountId },
      data: { deletedAt: now },
    });
  } else if (plan.type === "promote_and_leave") {
    await tx.accountMember.update({
      where: {
        userId_accountId: { userId: plan.successorUserId, accountId },
      },
      data: { role: "OWNER" },
    });
  }

  await tx.accountMember.delete({
    where: { userId_accountId: { userId, accountId } },
  });

  return plan;
}

module.exports = {
  planMembershipRemovalOnUserDelete,
  removeMembershipOnUserDelete,
};
