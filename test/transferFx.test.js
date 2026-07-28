const assert = require("node:assert/strict");
const test = require("node:test");

const { destinationAmountMinor } = require("../src/lib/transferFx");

test("same-currency transfers keep the source amount", () => {
  assert.equal(
    destinationAmountMinor({
      amountMinor: 1234,
      fxRate: null,
      sameCurrency: true,
    }),
    1234
  );
});

test("cross-currency transfers round with the provided fxRate", () => {
  assert.equal(
    destinationAmountMinor({
      amountMinor: 10000,
      fxRate: 1.1,
      sameCurrency: false,
    }),
    11000
  );
});

test("rejects cross-currency transfers that round destination credit to zero", () => {
  // Realistic VND→USD: 10_000 VND at ~0.00004 USD per VND rounds to 0 cents.
  assert.throws(
    () =>
      destinationAmountMinor({
        amountMinor: 10000,
        fxRate: 0.00004,
        sameCurrency: false,
      }),
    (err) =>
      err instanceof Error &&
      err.code === "FX_AMOUNT_ROUNDS_TO_ZERO" &&
      /rounds to zero/i.test(err.message)
  );
});

test("rejects tiny source amounts that round below one destination minor unit", () => {
  assert.throws(
    () =>
      destinationAmountMinor({
        amountMinor: 1,
        fxRate: 0.4,
        sameCurrency: false,
      }),
    (err) => err instanceof Error && err.code === "FX_AMOUNT_ROUNDS_TO_ZERO"
  );
});

test("allows the smallest destination credit of one minor unit", () => {
  assert.equal(
    destinationAmountMinor({
      amountMinor: 1,
      fxRate: 0.5,
      sameCurrency: false,
    }),
    1
  );
});
