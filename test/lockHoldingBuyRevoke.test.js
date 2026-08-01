const assert = require("node:assert/strict");
const test = require("node:test");

const {
  lockOpenHoldingForUpdate,
  planBuyRevokeHoldingUpdate,
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

test("planBuyRevokeHoldingUpdate removes the revoked lot from a locked holding", () => {
  const planned = planBuyRevokeHoldingUpdate({
    quantityHeld: 15,
    costBasisMinor: 1500,
    investmentQuantity: 10,
    amountMinor: 1000,
  });

  // Concurrent buy of 5 @ 500 already reflected in the locked read; revoke of
  // the original 10 @ 1000 must leave that newer lot intact.
  assert.equal(planned.newQty, 5);
  assert.equal(planned.newCost, 500);
  assert.equal(planned.shouldClose, false);
});

test("planBuyRevokeHoldingUpdate closes when the revoked buy was the only lot", () => {
  const planned = planBuyRevokeHoldingUpdate({
    quantityHeld: 10,
    costBasisMinor: 1000,
    investmentQuantity: 10,
    amountMinor: 1000,
  });

  assert.ok(planned.newQty < 1e-12);
  assert.equal(planned.newCost, 0);
  assert.equal(planned.shouldClose, true);
});

test("planBuyRevokeHoldingUpdate clamps quantity to what is currently held", () => {
  const planned = planBuyRevokeHoldingUpdate({
    quantityHeld: 3,
    costBasisMinor: 300,
    investmentQuantity: 10,
    amountMinor: 1000,
  });

  assert.equal(planned.qtyDec, 3);
  assert.equal(planned.newQty, 0);
  assert.equal(planned.shouldClose, true);
});
