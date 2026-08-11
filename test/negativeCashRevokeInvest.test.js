"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  throwIfInvestmentWouldCauseNegativeWalletBalance,
  throwIfCashBalancesAreNegative,
  lockAccountsForNegativeCashGuard,
} = require("../src/services/nonNegativeCashBalance");

/** Prisma.sql passes a single Sql object: { strings, values }. */
function sqlText(query) {
  if (query && Array.isArray(query.strings)) return query.strings.join("?");
  if (Array.isArray(query)) return query.join("?");
  return String(query);
}

function isAccountLockSql(query) {
  const text = sqlText(query);
  return /FROM\s+`Account`/i.test(text) && !/AccountWallet/i.test(text);
}

function lockAccountId(query) {
  return query?.values?.[0];
}

/**
 * Investment buys debit wallet piles but were never guarded by preventNegativeCashBalance.
 * With wallets live + lock on, a buy larger than the pile must fail closed.
 */
test("throwIfInvestmentWouldCauseNegativeWalletBalance rejects overspending wallet", async () => {
  const txs = [
    { type: "INCOME", amountMinor: 100 },
  ];
  let locked = false;

  const db = {
    account: {
      findFirst: async () => ({
        preventNegativeCashBalance: true,
        walletsEnabled: true,
        walletMigrationPending: false,
      }),
    },
    $queryRaw: async (query) => {
      assert.ok(isAccountLockSql(query));
      locked = true;
      return [{ id: "acct-1" }];
    },
    transaction: {
      findMany: async () => txs,
    },
  };

  await assert.rejects(
    () =>
      throwIfInvestmentWouldCauseNegativeWalletBalance(
        db,
        "acct-1",
        150,
        "wallet-1"
      ),
    (err) => err && err.code === "NEGATIVE_CASH_BALANCE"
  );
  assert.equal(locked, true);
});

test("throwIfInvestmentWouldCauseNegativeWalletBalance no-ops when lock off", async () => {
  const db = {
    account: {
      findFirst: async () => ({
        preventNegativeCashBalance: false,
        walletsEnabled: true,
        walletMigrationPending: false,
      }),
    },
    $queryRaw: async () => {
      throw new Error("must not lock when preventNegativeCashBalance is off");
    },
  };

  await throwIfInvestmentWouldCauseNegativeWalletBalance(
    db,
    "acct-1",
    999,
    "wallet-1"
  );
});

test("throwIfInvestmentWouldCauseNegativeWalletBalance no-ops without walletId", async () => {
  const db = {
    account: {
      findFirst: async () => {
        throw new Error("must not load account when walletId is null");
      },
    },
  };

  await throwIfInvestmentWouldCauseNegativeWalletBalance(db, "acct-1", 50, null);
});

/**
 * Revoking income (or a transfer credit leg) after the proceeds were spent must not
 * leave the book/wallet negative when preventNegativeCashBalance is on.
 */
test("throwIfCashBalancesAreNegative rejects negative book cash", async () => {
  const db = {
    account: {
      findFirst: async () => ({
        preventNegativeCashBalance: true,
        walletsEnabled: false,
        walletMigrationPending: false,
      }),
    },
    $queryRaw: async () => [{ id: "acct-1" }],
    transaction: {
      groupBy: async () => [
        { type: "INCOME", _sum: { amountMinor: 0 } },
        { type: "EXPENSE", _sum: { amountMinor: 50 } },
      ],
    },
  };

  await assert.rejects(
    () => throwIfCashBalancesAreNegative(db, "acct-1"),
    (err) => err && err.code === "NEGATIVE_CASH_BALANCE"
  );
});

test("throwIfCashBalancesAreNegative rejects negative wallet pile", async () => {
  const db = {
    account: {
      findFirst: async () => ({
        preventNegativeCashBalance: true,
        walletsEnabled: true,
        walletMigrationPending: false,
      }),
    },
    $queryRaw: async () => [{ id: "acct-1" }],
    transaction: {
      groupBy: async () => [
        { type: "INCOME", _sum: { amountMinor: 100 } },
        { type: "EXPENSE", _sum: { amountMinor: 100 } },
      ],
      findMany: async ({ where }) => {
        // walletBalanceMinor path: destination wallet spent after transfer credit revoked
        if (where.walletId === "wallet-dest") {
          return [{ type: "EXPENSE", amountMinor: 100 }];
        }
        return [];
      },
    },
    accountWallet: {
      findMany: async () => [{ id: "wallet-dest" }],
    },
  };

  await assert.rejects(
    () => throwIfCashBalancesAreNegative(db, "acct-1"),
    (err) => err && err.code === "NEGATIVE_CASH_BALANCE"
  );
});

test("lockAccountsForNegativeCashGuard locks only accounts with the flag, in sorted order", async () => {
  const locked = [];
  const flags = {
    "acct-b": true,
    "acct-a": true,
    "acct-c": false,
  };

  const db = {
    account: {
      findFirst: async ({ where }) => ({
        preventNegativeCashBalance: flags[where.id],
        walletsEnabled: false,
        walletMigrationPending: false,
      }),
    },
    $queryRaw: async (query) => {
      assert.ok(isAccountLockSql(query));
      const id = lockAccountId(query);
      locked.push(id);
      return [{ id }];
    },
  };

  await lockAccountsForNegativeCashGuard(db, ["acct-b", "acct-c", "acct-a"]);
  assert.deepEqual(locked, ["acct-a", "acct-b"]);
});
