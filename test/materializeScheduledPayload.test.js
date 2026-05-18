const assert = require("node:assert/strict");
const test = require("node:test");

const { materializeScheduledPayload } = require("../src/services/materializeScheduledPayload");

test("scheduled investment buys reactivate a previously soft-deleted holding", async () => {
  let holdingUpsertArgs;

  const tx = {
    account: {
      findFirst: async () => ({
        id: "acct_1",
        currency: "USD",
        investingEnabled: true,
        walletsEnabled: false,
      }),
    },
    instrument: {
      findFirst: async () => ({
        id: "inst_1",
        name: "Example Inc",
        providerSymbol: "EXM",
      }),
    },
    category: {
      findFirst: async () => ({
        id: "cat_inv",
        type: "INVESTMENT",
        internalKey: null,
        lockedForManualEntry: false,
        memberAccessRestricted: false,
      }),
    },
    user: {
      findUnique: async () => ({ personalAccountId: "acct_1" }),
    },
    transaction: {
      create: async () => ({ id: "tx_1" }),
    },
    holding: {
      upsert: async (args) => {
        holdingUpsertArgs = args;
        return { id: "holding_1" };
      },
    },
    auditLog: {
      create: async () => ({}),
    },
  };

  await materializeScheduledPayload(tx, {
    accountId: "acct_1",
    userId: "user_1",
    occurredAt: new Date("2026-05-18T00:00:00.000Z"),
    scheduleKind: "RECURRING",
    payload: {
      tab: "invest",
      amountMinor: 12345,
      categoryId: "cat_inv",
      instrumentId: "inst_1",
      quantity: 2,
    },
  });

  assert.equal(holdingUpsertArgs.update.deletedAt, null);
});
