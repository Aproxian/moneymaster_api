"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertOpenWalletLocked,
  WalletUnavailableError,
  lockOpenWalletForUpdate,
} = require("../src/lib/lockWallet");

function sqlText(strings) {
  return Array.isArray(strings) ? strings.join("?") : String(strings);
}

/**
 * Critical race: ledger writers (manual create / buy / cash-out / schedule
 * materialize) historically validated open wallets with a non-locking read,
 * then stamped Transaction.walletId. Concurrent DELETE of an empty wallet
 * could commit first; income/buy/proceeds then landed on a hidden deletedAt
 * wallet and trapped cash.
 */
test("assertOpenWalletLocked fails closed when wallet cannot be locked open", async () => {
  const tx = {
    $queryRaw: async () => [],
  };

  await assert.rejects(
    () => assertOpenWalletLocked(tx, { walletId: "gone", accountId: "acct-1" }),
    (err) => {
      assert.ok(err instanceof WalletUnavailableError);
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "wallet_unavailable");
      return true;
    }
  );
});

test("assertOpenWalletLocked returns the locked wallet id", async () => {
  const tx = {
    $queryRaw: async (strings, ...params) => {
      assert.match(sqlText(strings), /FOR UPDATE/i);
      assert.match(sqlText(strings), /deletedAt IS NULL/);
      assert.equal(params[0], "w-1");
      assert.equal(params[1], "acct-1");
      return [{ id: "w-1" }];
    },
  };

  const locked = await assertOpenWalletLocked(tx, {
    walletId: "w-1",
    accountId: "acct-1",
  });
  assert.deepEqual(locked, { id: "w-1" });
});

test("lockOpenWalletForUpdate returns null when no open row exists", async () => {
  const tx = {
    $queryRaw: async () => [],
  };
  const locked = await lockOpenWalletForUpdate(tx, {
    walletId: "missing",
    accountId: "acct-1",
  });
  assert.equal(locked, null);
});
