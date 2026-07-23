class OwnerCannotLeaveError extends Error {
  constructor() {
    super("Account owners must transfer ownership before leaving");
    this.name = "OwnerCannotLeaveError";
  }
}

/**
 * Delete a membership only if it is still a non-owner at write time.
 *
 * Using a conditional delete closes the race where ownership is transferred to
 * a member after their leave request has read the old role.
 *
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} userId
 * @param {string} accountId
 */
async function deleteNonOwnerMembership(tx, userId, accountId) {
  const deleted = await tx.accountMember.deleteMany({
    where: {
      userId,
      accountId,
      role: { not: "OWNER" },
    },
  });

  if (deleted.count !== 1) {
    throw new OwnerCannotLeaveError();
  }
}

module.exports = {
  OwnerCannotLeaveError,
  deleteNonOwnerMembership,
};
