"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  WalletHasOpenTransactionsError,
  WalletBalanceNonemptyError,
  lockOpenWalletForUpdate,
  countOpenWalletTransactions,
  assertWalletDeletable,
} = require("../src/lib/walletDeleteGuard");

test("lockOpenWalletForUpdate issues FOR UPDATE and returns open wallet id", async () => {
  let sqlText = "";
  const values = [];
  const tx = {
    $queryRaw: async (strings, ...params) => {
      sqlText = Array.isArray(strings) ? strings.join("?") : String(strings);
      values.push(...params);
      return [{ id: "wallet-1" }];
    },
  };

  const locked = await lockOpenWalletForUpdate(tx, {
    walletId: "wallet-1",
    accountId: "account-1",
  });

  assert.match(sqlText, /FOR UPDATE/i);
  assert.match(sqlText, /FROM `AccountWallet`/);
  assert.deepEqual(values, ["wallet-1", "account-1"]);
  assert.deepEqual(locked, { id: "wallet-1" });
});

test("lockOpenWalletForUpdate returns null when wallet missing or already deleted", async () => {
  const tx = { $queryRaw: async () => [] };
  const locked = await lockOpenWalletForUpdate(tx, {
    walletId: "missing",
    accountId: "account-1",
  });
  assert.equal(locked, null);
});

test("countOpenWalletTransactions counts only live non-revoked rows", async () => {
  const calls = [];
  const db = {
    transaction: {
      count: async (args) => {
        calls.push(args);
        return 2;
      },
    },
  };

  const n = await countOpenWalletTransactions(db, "wallet-1");
  assert.equal(n, 2);
  assert.deepEqual(calls, [
    {
      where: { walletId: "wallet-1", deletedAt: null, revokedAt: null },
    },
  ]);
});

/**
 * Models the critical net-zero trap: income +100 and expense +100 yield
 * walletBalanceMinor === 0, but open rows remain. DELETE must fail closed
 * so a later revoke/reassign cannot resurrect funds on a hidden wallet.
 */
test("assertWalletDeletable rejects net-zero wallets that still have open ledger rows", async () => {
  const tx = {
    $queryRaw: async () => [{ id: "wallet-1" }],
    transaction: {
      findMany: async () => [
        { type: "INCOME", amountMinor: 100 },
        { type: "EXPENSE", amountMinor: 100 },
      ],
      count: async () => 2,
    },
  };

  await assert.rejects(
    () => assertWalletDeletable(tx, { walletId: "wallet-1", accountId: "account-1" }),
    (err) =>
      err instanceof WalletHasOpenTransactionsError &&
      err.statusCode === 409 &&
      err.code === "wallet_has_open_transactions" &&
      err.openTransactionCount === 2
  );
});

test("assertWalletDeletable rejects nonempty net balance", async () => {
  const tx = {
    $queryRaw: async () => [{ id: "wallet-1" }],
    transaction: {
      findMany: async () => [{ type: "INCOME", amountMinor: 50 }],
      count: async () => {
        throw new Error("count should not run when balance is nonempty");
      },
    },
  };

  await assert.rejects(
    () => assertWalletDeletable(tx, { walletId: "wallet-1", accountId: "account-1" }),
    (err) =>
      err instanceof WalletBalanceNonemptyError &&
      err.statusCode === 400 &&
      err.balanceMinor === 50
  );
});

test("assertWalletDeletable allows truly empty open wallets", async () => {
  const tx = {
    $queryRaw: async () => [{ id: "wallet-1" }],
    transaction: {
      findMany: async () => [],
      count: async () => 0,
    },
  };

  const locked = await assertWalletDeletable(tx, {
    walletId: "wallet-1",
    accountId: "account-1",
  });
  assert.deepEqual(locked, { id: "wallet-1" });
});

test("assertWalletDeletable returns 404 when wallet cannot be locked", async () => {
  const tx = {
    $queryRaw: async () => [],
    transaction: {
      findMany: async () => {
        throw new Error("should not read balance for missing wallet");
      },
    },
  };

  await assert.rejects(
    () => assertWalletDeletable(tx, { walletId: "missing", accountId: "account-1" }),
    (err) => err instanceof Error && err.statusCode === 404
  );
});
