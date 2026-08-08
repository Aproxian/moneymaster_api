const assert = require("node:assert/strict");
const test = require("node:test");

const { convertMinorUnits } = require("../src/lib/currencyFx");

test("rounds converted minor-unit values with the provided fxRate", () => {
  assert.equal(convertMinorUnits(10000, 1.1), 11000);
  assert.equal(convertMinorUnits(333, 0.5), 167);
});

test("preserves intentional zero amounts", () => {
  assert.equal(convertMinorUnits(0, 0.00004), 0);
});

test("rejects non-zero amounts that round to zero (e.g. weak VND→USD)", () => {
  // 10_000 VND at ~0.00004 USD per VND rounds to 0 cents and would wipe the row.
  assert.throws(
    () => convertMinorUnits(10000, 0.00004),
    (err) =>
      err instanceof Error &&
      err.code === "FX_AMOUNT_ROUNDS_TO_ZERO" &&
      /rounds to zero/i.test(err.message)
  );
});

test("rejects the smallest non-zero amount when fxRate rounds below one minor unit", () => {
  assert.throws(
    () => convertMinorUnits(1, 0.4),
    (err) => err instanceof Error && err.code === "FX_AMOUNT_ROUNDS_TO_ZERO"
  );
});

test("allows the smallest surviving credit of one minor unit", () => {
  assert.equal(convertMinorUnits(1, 0.5), 1);
});
