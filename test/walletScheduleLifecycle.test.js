"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { lockOpenWalletForUpdate } = require("../src/lib/lockWallet");
const {
  countPendingSchedulesForWallet,
  payloadReferencesWallet,
  stripWalletIdsFromPendingSchedules,
} = require("../src/lib/schedulePayloads");

test("payloadReferencesWallet matches only the exact walletId string", () => {
  assert.equal(
    payloadReferencesWallet({ tab: "expense", walletId: "w1" }, "w1"),
    true
  );
  assert.equal(
    payloadReferencesWallet({ tab: "expense", walletId: "w2" }, "w1"),
    false
  );
  assert.equal(payloadReferencesWallet({ tab: "expense" }, "w1"), false);
  assert.equal(payloadReferencesWallet(null, "w1"), false);
  assert.equal(payloadReferencesWallet(["w1"], "w1"), false);
});

test("countPendingSchedulesForWallet counts pending rows that reference the wallet", async () => {
  const calls = [];
  const prismaClient = {
    pendingTransactionSchedule: {
      findMany: async (args) => {
        calls.push(args);
        return [
          { payload: { tab: "expense", walletId: "wallet-a" } },
          { payload: { tab: "income", walletId: "wallet-b" } },
          { payload: { tab: "expense", walletId: "wallet-a" } },
          { payload: { tab: "expense" } },
          { payload: null },
        ];
      },
    },
  };

  const count = await countPendingSchedulesForWallet(
    prismaClient,
    "account-1",
    "wallet-a"
  );

  assert.equal(count, 2);
  assert.deepEqual(calls[0], {
    where: {
      accountId: "account-1",
      status: "PENDING",
      cancelledAt: null,
    },
    select: {
      payload: true,
    },
  });
});

test("stripWalletIdsFromPendingSchedules removes walletId and leaves other fields", async () => {
  const updates = [];
  const tx = {
    pendingTransactionSchedule: {
      findMany: async () => [
        {
          id: "sch-1",
          payload: {
            tab: "expense",
            amountMinor: 500,
            categoryId: "cat-1",
            walletId: "wallet-dead",
          },
        },
        {
          id: "sch-2",
          payload: { tab: "income", amountMinor: 100, categoryId: "cat-2" },
        },
      ],
      update: async ({ where, data }) => {
        updates.push({ where, data });
        return { id: where.id };
      },
    },
  };

  const updated = await stripWalletIdsFromPendingSchedules(tx, "account-1");

  assert.equal(updated, 1);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    where: { id: "sch-1" },
    data: {
      payload: {
        tab: "expense",
        amountMinor: 500,
        categoryId: "cat-1",
      },
    },
  });
  assert.equal(Object.hasOwn(updates[0].data.payload, "walletId"), false);
});

test("lockOpenWalletForUpdate issues FOR UPDATE against the open wallet", async () => {
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
  assert.match(sqlText, /deletedAt IS NULL/);
  assert.match(sqlText, /AccountWallet/);
  assert.deepEqual(values, ["wallet-1", "account-1"]);
  assert.deepEqual(locked, { id: "wallet-1" });
});

test("lockOpenWalletForUpdate returns null when wallet is missing or soft-deleted", async () => {
  const tx = {
    $queryRaw: async () => [],
  };

  const locked = await lockOpenWalletForUpdate(tx, {
    walletId: "wallet-missing",
    accountId: "account-1",
  });

  assert.equal(locked, null);
});
