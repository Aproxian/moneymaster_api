const assert = require("node:assert/strict");
const { test } = require("node:test");

const { convertMinorUnits } = require("../src/routes/accounts");

test("convertMinorUnits rounds converted minor-unit values consistently", () => {
  assert.equal(convertMinorUnits(12345, 1.1), 13580);
  assert.equal(convertMinorUnits(333, 0.5), 167);
});
