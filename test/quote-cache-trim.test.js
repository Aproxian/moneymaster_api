"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_QUOTE_CACHE_KEEP_PER_INSTRUMENT,
  parseKeepMostRecentCount,
  trimQuoteCache,
} = require("../src/services/quoteCacheTrim");

test("quote cache trim defaults to one row per instrument/provider", () => {
  assert.equal(parseKeepMostRecentCount(undefined), DEFAULT_QUOTE_CACHE_KEEP_PER_INSTRUMENT);
  assert.equal(parseKeepMostRecentCount(null), DEFAULT_QUOTE_CACHE_KEEP_PER_INSTRUMENT);
  assert.equal(parseKeepMostRecentCount(""), DEFAULT_QUOTE_CACHE_KEEP_PER_INSTRUMENT);
});

test("quote cache trim rejects zero and non-integer keep counts", () => {
  assert.throws(() => parseKeepMostRecentCount("0"), /positive integer/);
  assert.throws(() => parseKeepMostRecentCount("-1"), /positive integer/);
  assert.throws(() => parseKeepMostRecentCount("1.5"), /positive integer/);
  assert.throws(() => parseKeepMostRecentCount("abc"), /positive integer/);
});

test("quote cache trim deletes rows per instrument/provider partition", async () => {
  const counts = [10, 6];
  let capturedSql = "";
  let capturedValues = [];

  const fakePrisma = {
    quoteCache: {
      count: async () => counts.shift(),
    },
    $executeRaw: async (strings, ...values) => {
      capturedSql = strings.join("?");
      capturedValues = values;
    },
  };

  const result = await trimQuoteCache(fakePrisma, 2);

  assert.match(capturedSql, /ROW_NUMBER\(\) OVER/);
  assert.match(capturedSql, /PARTITION BY instrumentId, provider/);
  assert.doesNotMatch(capturedSql, /LIMIT/);
  assert.deepEqual(capturedValues, [2]);
  assert.deepEqual(result, {
    ok: true,
    keepMostRecentCount: 2,
    rowsBefore: 10,
    rowsDeleted: 4,
    rowsAfter: 6,
  });
});
