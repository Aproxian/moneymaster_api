const assert = require("node:assert/strict");
const test = require("node:test");

const {
  OpenHoldingsDisableError,
  InvestingDisabledError,
  lockAccountInvestingForUpdate,
  hasOpenHoldingQuantity,
  assertCanDisableInvestingLocked,
  assertInvestingEnabledLocked,
} = require("../src/lib/lockAccountInvesting");

test("lockAccountInvestingForUpdate issues FOR UPDATE on Account", async () => {
  let sqlText = "";
  const values = [];
  const tx = {
    $queryRaw: async (strings, ...params) => {
      sqlText = Array.isArray(strings) ? strings.join("?") : String(strings);
      values.push(...params);
      return [
        {
          id: "account-1",
          investingEnabled: 1,
          currency: "EUR",
          deletedAt: null,
        },
      ];
    },
  };

  const locked = await lockAccountInvestingForUpdate(tx, "account-1");

  assert.match(sqlText, /FOR UPDATE/i);
  assert.match(sqlText, /FROM `Account`/);
  assert.deepEqual(values, ["account-1"]);
  assert.deepEqual(locked, {
    id: "account-1",
    investingEnabled: true,
    currency: "EUR",
  });
});

test("lockAccountInvestingForUpdate returns null for missing or soft-deleted accounts", async () => {
  const missing = { $queryRaw: async () => [] };
  assert.equal(await lockAccountInvestingForUpdate(missing, "missing"), null);

  const deleted = {
    $queryRaw: async () => [
      {
        id: "account-1",
        investingEnabled: 1,
        currency: "EUR",
        deletedAt: new Date("2026-08-04T00:00:00.000Z"),
      },
    ],
  };
  assert.equal(await lockAccountInvestingForUpdate(deleted, "account-1"), null);
});

test("hasOpenHoldingQuantity treats tiny dust as closed and positive qty as open", () => {
  assert.equal(hasOpenHoldingQuantity([{ quantity: 0 }]), false);
  assert.equal(hasOpenHoldingQuantity([{ quantity: "1e-13" }]), false);
  assert.equal(hasOpenHoldingQuantity([{ quantity: "0.0000001" }]), true);
  assert.equal(hasOpenHoldingQuantity([{ quantity: 2 }]), true);
});

test("assertCanDisableInvestingLocked fails closed when an open holding exists", async () => {
  const tx = {
    $queryRaw: async () => [
      {
        id: "account-1",
        investingEnabled: 1,
        currency: "EUR",
        deletedAt: null,
      },
    ],
    holding: {
      findMany: async () => [{ quantity: 3 }],
    },
  };

  await assert.rejects(
    () => assertCanDisableInvestingLocked(tx, "account-1"),
    (err) =>
      err instanceof OpenHoldingsDisableError &&
      err.statusCode === 400 &&
      err.code === "open_holdings"
  );
});

test("assertCanDisableInvestingLocked treats already-disabled as idempotent", async () => {
  const tx = {
    $queryRaw: async () => [
      {
        id: "account-1",
        investingEnabled: 0,
        currency: "EUR",
        deletedAt: null,
      },
    ],
    holding: {
      findMany: async () => {
        throw new Error("should not inspect holdings when already disabled");
      },
    },
  };

  const result = await assertCanDisableInvestingLocked(tx, "account-1");
  assert.equal(result.alreadyDisabled, true);
  assert.equal(result.investingEnabled, false);
});

test("assertInvestingEnabledLocked rejects when investing is off", async () => {
  const tx = {
    $queryRaw: async () => [
      {
        id: "account-1",
        investingEnabled: 0,
        currency: "EUR",
        deletedAt: null,
      },
    ],
  };

  await assert.rejects(
    () => assertInvestingEnabledLocked(tx, "account-1"),
    (err) =>
      err instanceof InvestingDisabledError &&
      err.statusCode === 403 &&
      err.code === "investing_disabled"
  );
});

/**
 * Models the critical race: disable observed zero holdings outside the write
 * txn while a buy is mid-flight. Whichever side takes the account lock first
 * wins; the loser must fail closed so investing-off never coexists with a new
 * open holding.
 */
test("concurrent disable vs buy serializes on account lock", async () => {
  let investingEnabled = true;
  let openQty = 0;

  async function runDisable() {
    const tx = {
      $queryRaw: async () => [
        {
          id: "account-1",
          investingEnabled: investingEnabled ? 1 : 0,
          currency: "EUR",
          deletedAt: null,
        },
      ],
      holding: {
        findMany: async () => (openQty > 0 ? [{ quantity: openQty }] : []),
      },
    };

    const locked = await assertCanDisableInvestingLocked(tx, "account-1");
    if (!locked.alreadyDisabled) {
      investingEnabled = false;
    }
    return "disabled";
  }

  async function runBuy(qty) {
    const tx = {
      $queryRaw: async () => [
        {
          id: "account-1",
          investingEnabled: investingEnabled ? 1 : 0,
          currency: "EUR",
          deletedAt: null,
        },
      ],
    };

    await assertInvestingEnabledLocked(tx, "account-1");
    openQty += qty;
    return "bought";
  }

  // Buy wins the lock first: disable must then see the open holding.
  assert.equal(await runBuy(5), "bought");
  await assert.rejects(() => runDisable(), OpenHoldingsDisableError);
  assert.equal(investingEnabled, true);
  assert.equal(openQty, 5);

  // Reset and flip order: disable wins first, buy must fail closed.
  investingEnabled = true;
  openQty = 0;
  assert.equal(await runDisable(), "disabled");
  await assert.rejects(() => runBuy(5), InvestingDisabledError);
  assert.equal(investingEnabled, false);
  assert.equal(openQty, 0);
});
