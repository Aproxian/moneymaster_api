"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { z } = require("zod");

const { optionalCoercedDate, requiredCoercedDate } = require("../src/lib/zodDate");

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

test("requiredCoercedDate rejects null instead of coercing to Unix epoch", () => {
  assert.throws(() => requiredCoercedDate.parse(null));
});

test("requiredCoercedDate rejects undefined", () => {
  assert.throws(() => requiredCoercedDate.parse(undefined));
});

test("requiredCoercedDate still coerces valid explicit dates", () => {
  const result = requiredCoercedDate.parse("2026-08-06T12:00:00.000Z");

  assert.equal(result.toISOString(), "2026-08-06T12:00:00.000Z");
});

test("transfer create schema does not stamp epoch when occurredAt is null", () => {
  const schema = z.object({
    occurredAt: optionalCoercedDate,
  });
  const body = schema.parse({ occurredAt: null });
  const occurredAt = body.occurredAt ?? new Date("2026-08-06T11:00:00.000Z");

  assert.equal(body.occurredAt, undefined);
  assert.equal(occurredAt.toISOString(), "2026-08-06T11:00:00.000Z");
});

test("schedule create schema rejects null executeAt (would otherwise be immediately due)", () => {
  const schema = z.object({
    kind: z.literal("DELAY_ONCE"),
    executeAt: requiredCoercedDate,
  });

  assert.throws(() => schema.parse({ kind: "DELAY_ONCE", executeAt: null }));
});

test("raw z.coerce.date still maps null to epoch (documents the hazard)", () => {
  const epoch = z.coerce.date().parse(null);
  assert.equal(epoch.toISOString(), "1970-01-01T00:00:00.000Z");
});
