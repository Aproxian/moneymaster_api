const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  ymdToZonedNoonUtc,
  parseOccurredRangeBound,
  startOfZonedDayUtc,
  endOfZonedDayUtc,
} = require("../src/lib/timezone");

describe("ymdToZonedNoonUtc", () => {
  it("anchors UTC calendar dates at noon UTC", () => {
    const d = ymdToZonedNoonUtc("2026-09-08", "UTC");
    assert.equal(d.toISOString(), "2026-09-08T12:00:00.000Z");
  });

  it("anchors Europe/Athens noon behind UTC", () => {
    const d = ymdToZonedNoonUtc("2026-09-08", "Europe/Athens");
    assert.equal(d.toISOString(), "2026-09-08T09:00:00.000Z");
  });

  it("rejects impossible calendar dates instead of overflowing Date.UTC", () => {
    assert.equal(ymdToZonedNoonUtc("2026-02-31", "UTC"), null);
    assert.equal(ymdToZonedNoonUtc("2026-04-31", "UTC"), null);
    assert.equal(ymdToZonedNoonUtc("2025-02-29", "UTC"), null);
    assert.ok(ymdToZonedNoonUtc("2024-02-29", "UTC"));
  });
});

describe("parseOccurredRangeBound", () => {
  it("includes a UTC noon-anchored row when from=to is that YYYY-MM-DD", () => {
    const noon = ymdToZonedNoonUtc("2026-09-08", "UTC");
    const { date: from } = parseOccurredRangeBound("2026-09-08", "UTC", "from");
    const { date: to } = parseOccurredRangeBound("2026-09-08", "UTC", "to");
    assert.ok(noon >= from && noon <= to);
    // Previous bug: date-only `to` was UTC midnight, which excludes noon.
    assert.ok(noon > new Date("2026-09-08"));
    assert.ok(to > noon);
  });

  it("includes Europe/Athens noon when the bound is the same calendar date", () => {
    const noon = ymdToZonedNoonUtc("2026-09-08", "Europe/Athens");
    const { date: from } = parseOccurredRangeBound("2026-09-08", "Europe/Athens", "from");
    const { date: to } = parseOccurredRangeBound("2026-09-08", "Europe/Athens", "to");
    assert.ok(noon >= from && noon <= to);
    assert.ok(noon > new Date("2026-09-08"));
  });

  it("includes Pacific/Auckland NZDT noon even though it falls on the previous UTC date", () => {
    const noon = ymdToZonedNoonUtc("2026-01-15", "Pacific/Auckland");
    const { date: from } = parseOccurredRangeBound("2026-01-15", "Pacific/Auckland", "from");
    const { date: to } = parseOccurredRangeBound("2026-01-15", "Pacific/Auckland", "to");
    assert.equal(noon.toISOString(), "2026-01-14T23:00:00.000Z");
    assert.ok(noon >= from && noon <= to);
    assert.ok(noon < new Date("2026-01-15T00:00:00.000Z"));
  });

  it("includes Pacific/Kiritimati noon on the previous UTC date", () => {
    const noon = ymdToZonedNoonUtc("2026-09-08", "Pacific/Kiritimati");
    const { date: from } = parseOccurredRangeBound("2026-09-08", "Pacific/Kiritimati", "from");
    const { date: to } = parseOccurredRangeBound("2026-09-08", "Pacific/Kiritimati", "to");
    assert.ok(noon >= from && noon <= to);
    assert.ok(noon < new Date("2026-09-08T00:00:00.000Z"));
  });

  it("leaves ISO instants unchanged so existing clients keep working", () => {
    const { date: to } = parseOccurredRangeBound("2026-09-08T12:00:00.000Z", "UTC", "to");
    const { date: from } = parseOccurredRangeBound("2026-09-08T00:00:00.000Z", "Europe/Athens", "from");
    assert.equal(to.toISOString(), "2026-09-08T12:00:00.000Z");
    assert.equal(from.toISOString(), "2026-09-08T00:00:00.000Z");
  });

  it("rejects impossible YYYY-MM-DD query bounds", () => {
    const { error } = parseOccurredRangeBound("2026-02-31", "UTC", "to");
    assert.equal(error, "Invalid to date");
  });

  it("returns undefined for empty bounds", () => {
    assert.equal(parseOccurredRangeBound("", "UTC", "from").date, undefined);
    assert.equal(parseOccurredRangeBound(undefined, "UTC", "to").date, undefined);
  });
});

describe("start/end of zoned day", () => {
  it("covers a full UTC calendar day", () => {
    const start = startOfZonedDayUtc("2026-09-08", "UTC");
    const end = endOfZonedDayUtc("2026-09-08", "UTC");
    assert.equal(start.toISOString(), "2026-09-08T00:00:00.000Z");
    assert.equal(end.toISOString(), "2026-09-08T23:59:59.999Z");
  });
});
