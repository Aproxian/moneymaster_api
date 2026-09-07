const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { holdingAfterCashOut } = require("../src/lib/holdingAfterCashOut");

describe("holdingAfterCashOut", () => {
  it("keeps remaining shares when proportional cost rounds to zero", () => {
    // Buy 2 units for 1 cent, sell 1: round(1 * 1/2) = 1 → remaining cost 0, qty 1.
    const next = holdingAfterCashOut({
      quantityHeld: 2,
      costBasisMinor: 1,
      quantitySold: 1,
    });
    assert.equal(next.closed, false);
    assert.equal(next.quantity, 1);
    assert.equal(next.costBasisMinor, 0);
  });

  it("keeps a leftover crypto slice after cost basis is exhausted by rounding", () => {
    // 0.6 units left at 1 cent; sell half → round(1 * 0.5) = 1, remaining 0.3 at 0 cost.
    const next = holdingAfterCashOut({
      quantityHeld: 0.6,
      costBasisMinor: 1,
      quantitySold: 0.3,
    });
    assert.equal(next.closed, false);
    assert.ok(Math.abs(next.quantity - 0.3) < 1e-12);
    assert.equal(next.costBasisMinor, 0);
  });

  it("closes the holding only when remaining quantity is fully sold", () => {
    const next = holdingAfterCashOut({
      quantityHeld: 2,
      costBasisMinor: 1,
      quantitySold: 2,
    });
    assert.equal(next.closed, true);
    assert.equal(next.quantity, 0);
    assert.equal(next.costBasisMinor, 0);
  });

  it("reduces cost proportionally on a typical partial sale", () => {
    const next = holdingAfterCashOut({
      quantityHeld: 100,
      costBasisMinor: 10000,
      quantitySold: 40,
    });
    assert.equal(next.closed, false);
    assert.equal(next.quantity, 60);
    assert.equal(next.costBasisMinor, 6000);
  });

  it("closes dust remaining quantity", () => {
    const next = holdingAfterCashOut({
      quantityHeld: 1,
      costBasisMinor: 50,
      quantitySold: 1 - 1e-15,
    });
    assert.equal(next.closed, true);
    assert.equal(next.quantity, 0);
    assert.equal(next.costBasisMinor, 0);
  });
});
