const { test } = require("node:test");
const assert = require("node:assert/strict");

const { materializeScheduledPayload } = require("../src/services/materializeScheduledPayload");

function mockInvestTx() {
  /** @type {{ holdingUpsert: object | null }} */
  const calls = { holdingUpsert: null };
  const tx = {
    account: {
      findFirst: async () => ({
        id: "acc1",
        currency: "EUR",
        investingEnabled: true,
        walletsEnabled: false,
      }),
    },
    user: {
      findUnique: async () => ({ personalAccountId: "acc1" }),
    },
    instrument: {
      findFirst: async () => ({
        id: "inst1",
        name: "AAPL",
        providerSymbol: "AAPL",
      }),
    },
    category: {
      findFirst: async () => ({
        id: "cat1",
        type: "INVESTMENT",
        internalKey: null,
        lockedForManualEntry: false,
        memberAccessRestricted: false,
      }),
    },
    transaction: {
      create: async ({ data }) => ({ id: "tx1", ...data }),
    },
    holding: {
      upsert: async (args) => {
        calls.holdingUpsert = args;
        return { id: "hold1" };
      },
    },
    auditLog: {
      create: async () => ({}),
    },
  };
  return { tx, calls };
}

test("scheduled invest reopens a soft-deleted holding after full cash-out", async () => {
  const { tx, calls } = mockInvestTx();

  await materializeScheduledPayload(tx, {
    accountId: "acc1",
    userId: "user1",
    occurredAt: new Date("2026-08-13T12:00:00.000Z"),
    payload: {
      tab: "invest",
      amountMinor: 10000,
      categoryId: "cat1",
      instrumentId: "inst1",
      quantity: 2,
    },
    scheduleKind: "RECURRING",
  });

  assert.ok(calls.holdingUpsert, "holding upsert must run");
  assert.equal(calls.holdingUpsert.update.deletedAt, null);
  assert.deepEqual(calls.holdingUpsert.update.quantity, { increment: 2 });
  assert.deepEqual(calls.holdingUpsert.update.costBasisMinor, { increment: 10000 });
});
