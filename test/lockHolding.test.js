const assert = require("node:assert/strict");
const test = require("node:test");

const {
  lockOpenHoldingForUpdate,
  planCashOutHoldingUpdate,
} = require("../src/lib/lockHolding");

test("lockOpenHoldingForUpdate issues FOR UPDATE against the open holding", async () => {
  let sqlText = "";
  const values = [];
  const tx = {
    $queryRaw: async (strings, ...params) => {
      sqlText = Array.isArray(strings) ? strings.join("?") : String(strings);
      values.push(...params);
      return [
        {
          id: "holding-1",
          quantity: "10",
          costBasisMinor: 1000,
          categoryId: "cat-1",
        },
      ];
    },
  };

  const locked = await lockOpenHoldingForUpdate(tx, {
    accountId: "account-1",
    instrumentId: "instrument-1",
  });

  assert.match(sqlText, /FOR UPDATE/i);
  assert.match(sqlText, /deletedAt IS NULL/);
  assert.deepEqual(values, ["account-1", "instrument-1"]);
  assert.deepEqual(locked, {
    id: "holding-1",
    quantity: "10",
    costBasisMinor: 1000,
    categoryId: "cat-1",
  });
});

test("lockOpenHoldingForUpdate returns null when no open holding exists", async () => {
  const tx = {
    $queryRaw: async () => [],
  };

  const locked = await lockOpenHoldingForUpdate(tx, {
    accountId: "account-1",
    instrumentId: "instrument-1",
  });

  assert.equal(locked, null);
});

test("planCashOutHoldingUpdate rejects oversell before any write", () => {
  assert.throws(
    () =>
      planCashOutHoldingUpdate({
        quantityHeld: 10,
        costBasisMinor: 1000,
        quantitySold: 10.0001,
      }),
    (err) => err instanceof Error && err.message === "QTY_TOO_LARGE"
  );
});

test("planCashOutHoldingUpdate computes proportional remaining quantity and cost", () => {
  const planned = planCashOutHoldingUpdate({
    quantityHeld: 10,
    costBasisMinor: 1000,
    quantitySold: 4,
  });

  assert.equal(planned.newQty, 6);
  assert.equal(planned.costRemoved, 400);
  assert.equal(planned.newCost, 600);
  assert.equal(planned.shouldClose, false);
});

test("planCashOutHoldingUpdate closes the holding when quantity is fully sold", () => {
  const planned = planCashOutHoldingUpdate({
    quantityHeld: 5,
    costBasisMinor: 250,
    quantitySold: 5,
  });

  assert.ok(planned.newQty < 1e-12);
  assert.equal(planned.shouldClose, true);
});
