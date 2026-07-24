const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  convertMinorUnits,
  convertSchedulePayloadCurrency,
} = require("../src/routes/accounts");

test("convertMinorUnits matches ledger FX rounding", () => {
  assert.equal(convertMinorUnits(10000, 1.1), 11000);
  assert.equal(convertMinorUnits(12345, 1.1), 13580);
  assert.equal(convertMinorUnits(333, 0.5), 167);
});

test("convertSchedulePayloadCurrency scales recurring/delayed schedule amounts", () => {
  const income = convertSchedulePayloadCurrency(
    {
      tab: "income",
      amountMinor: 10000,
      categoryId: "cat_income",
      note: "salary",
    },
    1.1
  );
  assert.deepEqual(income, {
    tab: "income",
    amountMinor: 11000,
    categoryId: "cat_income",
    note: "salary",
  });

  const invest = convertSchedulePayloadCurrency(
    {
      tab: "invest",
      amountMinor: 25000,
      categoryId: "cat_invest",
      instrumentId: "inst_1",
      quantity: 2.5,
    },
    0.85
  );
  assert.equal(invest.amountMinor, 21250);
  assert.equal(invest.quantity, 2.5);
  assert.equal(invest.instrumentId, "inst_1");
});

test("convertSchedulePayloadCurrency ignores non-convertible payloads", () => {
  assert.equal(convertSchedulePayloadCurrency(null, 1.1), null);
  assert.equal(convertSchedulePayloadCurrency([], 1.1), null);
  assert.equal(convertSchedulePayloadCurrency({ tab: "expense" }, 1.1), null);
  assert.equal(
    convertSchedulePayloadCurrency({ amountMinor: "not-a-number" }, 1.1),
    null
  );
});
