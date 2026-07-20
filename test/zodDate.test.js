const test = require("node:test");
const assert = require("node:assert/strict");

const { optionalCoercedDate } = require("../src/lib/zodDate");

test("optionalCoercedDate treats null as omitted", () => {
  const result = optionalCoercedDate.parse(null);

  assert.equal(result, undefined);
});

test("optionalCoercedDate still coerces valid explicit dates", () => {
  const result = optionalCoercedDate.parse("2026-07-20T10:30:00.000Z");

  assert.equal(result.toISOString(), "2026-07-20T10:30:00.000Z");
});

test("optionalCoercedDate rejects invalid explicit dates", () => {
  assert.throws(() => optionalCoercedDate.parse("not-a-date"));
});
