const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PRISMA_INT_MAX,
  applyFxToMinorUnits,
  isFxAmountError,
} = require("../src/lib/fxAmount");

test("rounds converted minor-unit values with the provided fxRate", () => {
  assert.equal(applyFxToMinorUnits(10000, 1.1), 11000);
  assert.equal(applyFxToMinorUnits(333, 0.5), 167);
});

test("allows values at the Prisma Int maximum", () => {
  assert.equal(applyFxToMinorUnits(PRISMA_INT_MAX, 1), PRISMA_INT_MAX);
});

test("rejects USD→VND conversion that exceeds signed 32-bit Int", () => {
  // $859.00 at 25_000 VND per USD → 21,475,000,000 minor units (> INT_MAX).
  assert.throws(
    () => applyFxToMinorUnits(85900, 25000),
    (err) =>
      err instanceof Error &&
      err.code === "FX_AMOUNT_OVERFLOW" &&
      /exceed the maximum stored amount/i.test(err.message)
  );
});

test("rejects USD→IDR transfer of ~$1,343 that overflows Int", () => {
  assert.throws(
    () => applyFxToMinorUnits(134300, 16000),
    (err) => err instanceof Error && err.code === "FX_AMOUNT_OVERFLOW"
  );
});

test("allows a USD→VND amount that still fits in Int", () => {
  // $858.00 at 25_000 → 2,145,000,000 which is just under INT_MAX.
  assert.equal(applyFxToMinorUnits(85800, 25000), 2_145_000_000);
});

test("rejects non-finite results (e.g. Infinite fxRate)", () => {
  assert.throws(
    () => applyFxToMinorUnits(100, Number.POSITIVE_INFINITY),
    (err) => err instanceof Error && err.code === "FX_AMOUNT_INVALID"
  );
});

test("isFxAmountError identifies conversion failures", () => {
  try {
    applyFxToMinorUnits(85900, 25000);
    assert.fail("expected throw");
  } catch (err) {
    assert.equal(isFxAmountError(err), true);
  }
  assert.equal(isFxAmountError(new Error("nope")), false);
  assert.equal(isFxAmountError(null), false);
});
