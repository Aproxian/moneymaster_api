const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isInvestmentCashOut,
} = require("../src/lib/investmentTransactions");

test("recognizes current cash-out rows by negative investment quantity", () => {
  assert.equal(
    isInvestmentCashOut({
      type: "INCOME",
      instrumentId: "instrument-1",
      investmentQuantity: "-4",
      category: null,
    }),
    true
  );
});

test("recognizes legacy cash-out rows by system category", () => {
  assert.equal(
    isInvestmentCashOut({
      type: "INCOME",
      instrumentId: "instrument-1",
      investmentQuantity: null,
      category: { internalKey: "CASH_OUT_INVESTMENT" },
    }),
    true
  );
});

test("does not classify ordinary income or investment purchases as cash-outs", () => {
  assert.equal(
    isInvestmentCashOut({
      type: "INCOME",
      instrumentId: null,
      investmentQuantity: null,
      category: { internalKey: "CASH_OUT_INVESTMENT" },
    }),
    false
  );
  assert.equal(
    isInvestmentCashOut({
      type: "INVESTMENT",
      instrumentId: "instrument-1",
      investmentQuantity: "4",
      category: { internalKey: "INV_STOCKS" },
    }),
    false
  );
});
