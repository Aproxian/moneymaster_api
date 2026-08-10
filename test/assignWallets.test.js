"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AssignWalletsError,
  walletContributionMinor,
  applyWalletAssignments,
} = require("../src/lib/assignWallets");
const { lockOpenWalletForUpdate } = require("../src/lib/lockWallet");

function sqlText(strings) {
  return Array.isArray(strings) ? strings.join("?") : String(strings);
}

function isAccountLockSql(strings) {
  const text = sqlText(strings);
  return /FROM\s+`Account`/i.test(text) && !/AccountWallet/i.test(text);
}

function isWalletLockSql(strings) {
  return /AccountWallet/i.test(sqlText(strings));
}

test("walletContributionMinor matches walletBalanceMinor signs", () => {
  assert.equal(walletContributionMinor({ type: "INCOME", amountMinor: 100 }), 100);
  assert.equal(walletContributionMinor({ type: "EXPENSE", amountMinor: 40 }), -40);
  assert.equal(walletContributionMinor({ type: "INVESTMENT", amountMinor: 25 }), -25);
  assert.equal(walletContributionMinor({ type: "OTHER", amountMinor: 10 }), 0);
});

test("lockOpenWalletForUpdate issues FOR UPDATE against open wallets", async () => {
  let text = "";
  const values = [];
  const tx = {
    $queryRaw: async (strings, ...params) => {
      text = sqlText(strings);
      values.push(...params);
      return [{ id: "wallet-1" }];
    },
  };

  const locked = await lockOpenWalletForUpdate(tx, {
    walletId: "wallet-1",
    accountId: "account-1",
  });

  assert.match(text, /FOR UPDATE/i);
  assert.match(text, /deletedAt IS NULL/);
  assert.deepEqual(values, ["wallet-1", "account-1"]);
  assert.deepEqual(locked, { id: "wallet-1" });
});

/**
 * Critical race: assign-wallets validated wallets outside the write txn, then
 * stamped walletId after cancel/disable/delete soft-deleted the target.
 * Income landed on a hidden deletedAt wallet (fund trap).
 */
test("applyWalletAssignments rejects targets that cannot be locked as open", async () => {
  const locked = [];
  const tx = {
    $queryRaw: async (strings, ...params) => {
      if (isAccountLockSql(strings)) {
        return [
          {
            id: "account-1",
            preventNegativeCashBalance: 0,
            walletsEnabled: 1,
            walletMigrationPending: 0,
          },
        ];
      }
      if (isWalletLockSql(strings)) {
        locked.push(params[0]);
        return [];
      }
      throw new Error(`unexpected sql: ${sqlText(strings)}`);
    },
    transaction: {
      findMany: async () => [
        { id: "tx-1", type: "INCOME", amountMinor: 500, walletId: null },
      ],
      updateMany: async () => {
        throw new Error("must not update after wallet unavailable");
      },
    },
  };

  await assert.rejects(
    () =>
      applyWalletAssignments(tx, {
        accountId: "account-1",
        assignments: [{ transactionId: "tx-1", walletId: "wallet-dead" }],
      }),
    (err) =>
      err instanceof AssignWalletsError &&
      err.statusCode === 409 &&
      err.code === "wallet_unavailable"
  );
  assert.deepEqual(locked, ["wallet-dead"]);
});

test("applyWalletAssignments rejects duplicate transaction ids", async () => {
  const tx = {
    $queryRaw: async () => {
      throw new Error("should fail before db access");
    },
  };

  await assert.rejects(
    () =>
      applyWalletAssignments(tx, {
        accountId: "account-1",
        assignments: [
          { transactionId: "tx-1", walletId: "w1" },
          { transactionId: "tx-1", walletId: "w2" },
        ],
      }),
    (err) =>
      err instanceof AssignWalletsError &&
      err.code === "duplicate_transaction_id" &&
      err.statusCode === 400
  );
});

test("applyWalletAssignments rejects pile-breaking moves when preventNegative is on", async () => {
  const balances = {
    "wallet-cash": 100,
    "wallet-empty": 0,
  };

  const tx = {
    $queryRaw: async (strings, ...params) => {
      if (isAccountLockSql(strings)) {
        return [
          {
            id: "account-1",
            preventNegativeCashBalance: 1,
            walletsEnabled: 1,
            walletMigrationPending: 0,
          },
        ];
      }
      if (isWalletLockSql(strings)) {
        return [{ id: params[0] }];
      }
      throw new Error(`unexpected sql: ${sqlText(strings)}`);
    },
    transaction: {
      findMany: async (args) => {
        if (args?.where?.walletId && args?.select?.type) {
          const id = args.where.walletId;
          const bal = balances[id] ?? 0;
          return bal > 0 ? [{ type: "INCOME", amountMinor: bal }] : [];
        }
        return [
          {
            id: "tx-exp",
            type: "EXPENSE",
            amountMinor: 150,
            walletId: "wallet-cash",
          },
        ];
      },
      updateMany: async () => {
        throw new Error("must not update when pile would go negative");
      },
    },
  };

  await assert.rejects(
    () =>
      applyWalletAssignments(tx, {
        accountId: "account-1",
        assignments: [{ transactionId: "tx-exp", walletId: "wallet-empty" }],
      }),
    (err) =>
      err instanceof AssignWalletsError &&
      err.code === "NEGATIVE_CASH_BALANCE" &&
      err.statusCode === 400
  );
});

test("applyWalletAssignments updates under lock when targets stay open", async () => {
  const updates = [];
  const tx = {
    $queryRaw: async (strings, ...params) => {
      if (isAccountLockSql(strings)) {
        return [
          {
            id: "account-1",
            preventNegativeCashBalance: 0,
            walletsEnabled: 0,
            walletMigrationPending: 1,
          },
        ];
      }
      if (isWalletLockSql(strings)) {
        return [{ id: params[0] }];
      }
      throw new Error(`unexpected sql: ${sqlText(strings)}`);
    },
    transaction: {
      findMany: async () => [
        { id: "tx-1", type: "INCOME", amountMinor: 50, walletId: null },
      ],
      updateMany: async (args) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  };

  const result = await applyWalletAssignments(tx, {
    accountId: "account-1",
    assignments: [{ transactionId: "tx-1", walletId: "wallet-1" }],
  });

  assert.deepEqual(result, { updated: 1 });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].data, { walletId: "wallet-1" });
  assert.equal(updates[0].where.id, "tx-1");
  assert.equal(updates[0].where.revokedAt, null);
});
