"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertTransferWalletsLocked,
  TransferWalletUnavailableError,
} = require("../src/lib/transferWallets");

function sqlText(strings) {
  return Array.isArray(strings) ? strings.join("?") : String(strings);
}

test("assertTransferWalletsLocked locks unique wallets in stable account/wallet order", async () => {
  const locked = [];
  const tx = {
    $queryRaw: async (strings, ...params) => {
      assert.match(sqlText(strings), /FOR UPDATE/i);
      assert.match(sqlText(strings), /deletedAt IS NULL/);
      locked.push({ walletId: params[0], accountId: params[1] });
      return [{ id: params[0] }];
    },
  };

  await assertTransferWalletsLocked(tx, [
    { walletId: "w-b", accountId: "acct-z" },
    null,
    { walletId: "w-a", accountId: "acct-a" },
    { walletId: "w-b", accountId: "acct-z" }, // duplicate ignored
    { walletId: "w-c", accountId: "acct-a" },
  ]);

  assert.deepEqual(locked, [
    { walletId: "w-a", accountId: "acct-a" },
    { walletId: "w-c", accountId: "acct-a" },
    { walletId: "w-b", accountId: "acct-z" },
  ]);
});

/**
 * Critical race: transfer create validated open wallets outside the write txn,
 * then stamped Transaction.walletId. Concurrent DELETE of an empty destination
 * wallet could commit first; the transfer INCOME then landed on a hidden
 * deletedAt wallet and trapped cash (especially with preventNegativeCashBalance).
 */
test("assertTransferWalletsLocked fails closed when a wallet cannot be locked open", async () => {
  const tx = {
    $queryRaw: async () => [],
  };

  await assert.rejects(
    () =>
      assertTransferWalletsLocked(tx, [
        { walletId: "deleted-wallet", accountId: "acct-1" },
      ]),
    (err) => {
      assert.ok(err instanceof TransferWalletUnavailableError);
      assert.equal(err.statusCode, 409);
      assert.equal(err.code, "wallet_unavailable");
      return true;
    }
  );
});

test("assertTransferWalletsLocked no-ops when no wallet refs are provided", async () => {
  const tx = {
    $queryRaw: async () => {
      throw new Error("should not lock");
    },
  };

  await assertTransferWalletsLocked(tx, [null, undefined, {}]);
});
