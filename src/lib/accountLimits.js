"use strict";

/** Maximum books (accounts) a user may belong to at once, including their personal book. */
const MAX_ACCOUNTS_PER_USER = 10;

const ACCOUNT_LIMIT_REACHED_MESSAGE =
  "You can be part of at most 10 accounts (including your personal book).";

const INVITEE_AT_ACCOUNT_LIMIT_MESSAGE =
  "That user already has the maximum number of accounts (10) and cannot join another book.";

class AccountLimitError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = "AccountLimitError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

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

/**
 * Serializes account membership creation for one user so concurrent creates/accepts
 * cannot all pass the cap check before any of them writes the new membership.
 * @param {import("@prisma/client").Prisma.TransactionClient} tx
 * @param {string} userId
 * @param {{ message?: string; code?: string; statusCode?: number }} [options]
 */
async function assertCanAddActiveAccountMembership(tx, userId, options = {}) {
  await tx.$queryRaw`SELECT id FROM \`User\` WHERE id = ${userId} FOR UPDATE`;

  const membershipCount = await countActiveAccountMemberships(tx, userId);
  if (membershipCount >= MAX_ACCOUNTS_PER_USER) {
    throw new AccountLimitError(
      options.message ?? ACCOUNT_LIMIT_REACHED_MESSAGE,
      options.code ?? "ACCOUNT_LIMIT_REACHED",
      options.statusCode ?? 403
    );
  }
}

function isAccountLimitError(err) {
  return err instanceof AccountLimitError || err?.name === "AccountLimitError";
}

module.exports = {
  MAX_ACCOUNTS_PER_USER,
  ACCOUNT_LIMIT_REACHED_MESSAGE,
  INVITEE_AT_ACCOUNT_LIMIT_MESSAGE,
  AccountLimitError,
  assertCanAddActiveAccountMembership,
  countActiveAccountMemberships,
  isAccountLimitError,
};
