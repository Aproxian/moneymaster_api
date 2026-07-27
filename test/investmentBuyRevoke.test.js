const assert = require("node:assert/strict");
const test = require("node:test");

const {
  BuyRevokeAfterCashOutError,
  openCashOutWhere,
  assertInvestmentBuyRevokeSafe,
  shouldCloseHoldingAfterBuyRevoke,
} = require("../src/lib/investmentBuyRevoke");

test("openCashOutWhere matches negative quantity and legacy cash-out category", () => {
  assert.deepEqual(openCashOutWhere({ accountId: "a1", instrumentId: "i1" }), {
    accountId: "a1",
    instrumentId: "i1",
    deletedAt: null,
    revokedAt: null,
    type: "INCOME",
    OR: [
      { investmentQuantity: { lt: 0 } },
      { category: { internalKey: "CASH_OUT_INVESTMENT" } },
    ],
  });
});

test("assertInvestmentBuyRevokeSafe rejects when an open cash-out exists", async () => {
  let where;
  const tx = {
    transaction: {
      findFirst: async (query) => {
        where = query.where;
        return { id: "cash-out-1" };
      },
    },
  };

  await assert.rejects(
    () =>
      assertInvestmentBuyRevokeSafe(tx, {
        accountId: "account-1",
        instrumentId: "instrument-1",
      }),
    BuyRevokeAfterCashOutError
  );

  assert.equal(where.accountId, "account-1");
  assert.equal(where.instrumentId, "instrument-1");
  assert.equal(where.type, "INCOME");
});

test("assertInvestmentBuyRevokeSafe allows revoke when no cash-out exists", async () => {
  const tx = {
    transaction: {
      findFirst: async () => null,
    },
  };

  await assert.doesNotReject(() =>
    assertInvestmentBuyRevokeSafe(tx, {
      accountId: "account-1",
      instrumentId: "instrument-1",
    })
  );
});

test("shouldCloseHoldingAfterBuyRevoke preserves remaining qty when cost hits zero", () => {
  // Buy 10 @ 10000, cash out 9 (cost→1000), buy 10 @ 1 (qty→11, cost→1001),
  // then a naive revoke of the original buy can drive newCost to 0 with qty left.
  assert.equal(
    shouldCloseHoldingAfterBuyRevoke({ newQty: 1, newCost: 0 }),
    false
  );
  assert.equal(
    shouldCloseHoldingAfterBuyRevoke({ newQty: 0, newCost: 0 }),
    true
  );
  assert.equal(
    shouldCloseHoldingAfterBuyRevoke({ newQty: 1e-13, newCost: 500 }),
    true
  );
});
