"use strict";

/** Maximum books (accounts) a user may belong to at once, including their personal book. */
const MAX_ACCOUNTS_PER_USER = 10;

const ACCOUNT_LIMIT_REACHED_MESSAGE =
  "You can be part of at most 10 accounts (including your personal book).";

const INVITEE_AT_ACCOUNT_LIMIT_MESSAGE =
  "That user already has the maximum number of accounts (10) and cannot join another book.";

/**
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {string} userId
 */
async function countActiveAccountMemberships(prisma, userId) {
  return prisma.accountMember.count({
    where: {
      userId,
      account: { deletedAt: null },
    },
  });
}

module.exports = {
  MAX_ACCOUNTS_PER_USER,
  ACCOUNT_LIMIT_REACHED_MESSAGE,
  INVITEE_AT_ACCOUNT_LIMIT_MESSAGE,
  countActiveAccountMemberships,
};
