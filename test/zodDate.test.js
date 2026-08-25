const test = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");

const { optionalCoercedDate, requiredCoercedDate } = require("../src/lib/zodDate");

test("z.coerce.date maps JSON null to the Unix epoch (the hazard this helper exists for)", () => {
  const parsed = z.coerce.date().parse(null);
  assert.equal(parsed.toISOString(), "1970-01-01T00:00:00.000Z");
});

test("optionalCoercedDate treats null as omitted", () => {
  const result = optionalCoercedDate.parse(null);
  assert.equal(result, undefined);
});

test("optionalCoercedDate treats undefined as omitted", () => {
  const result = optionalCoercedDate.parse(undefined);
  assert.equal(result, undefined);
});

test("optionalCoercedDate still coerces valid explicit dates", () => {
  const result = optionalCoercedDate.parse("2026-07-20T10:30:00.000Z");
  assert.equal(result.toISOString(), "2026-07-20T10:30:00.000Z");
});

test("optionalCoercedDate rejects invalid explicit dates", () => {
  assert.throws(() => optionalCoercedDate.parse("not-a-date"));
});

test("requiredCoercedDate rejects JSON null instead of coercing to epoch", () => {
  assert.throws(() => requiredCoercedDate.parse(null));
});

test("requiredCoercedDate rejects omitted values", () => {
  assert.throws(() => requiredCoercedDate.parse(undefined));
});

test("requiredCoercedDate still coerces valid explicit dates", () => {
  const result = requiredCoercedDate.parse("2026-08-25T11:00:00.000Z");
  assert.equal(result.toISOString(), "2026-08-25T11:00:00.000Z");
});

test("transfer-style body with occurredAt null does not become epoch", () => {
  const schema = z.object({
    amountMinor: z.number().int().positive(),
    occurredAt: optionalCoercedDate,
  });
  const parsed = schema.parse({ amountMinor: 100, occurredAt: null });
  assert.equal(parsed.occurredAt, undefined);
  const occurredAt = parsed.occurredAt ?? new Date();
  assert.ok(occurredAt.getTime() > Date.parse("2000-01-01T00:00:00.000Z"));
});

test("schedule-style body with startAt null is rejected", () => {
  const schema = z.object({
    kind: z.literal("RECURRING"),
    startAt: requiredCoercedDate,
  });
  assert.throws(() => schema.parse({ kind: "RECURRING", startAt: null }));
});
