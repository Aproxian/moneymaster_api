const assert = require("node:assert/strict");
const test = require("node:test");

const {
  __private: {
    authorizeQuoteCacheTrimRequest,
    parseQuoteCacheTrimKeepCount,
    trimQuoteCacheRows,
  },
} = require("../src/routes/investments");

function createJsonResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("quote-cache trim requires configured admin for non-cron JWT callers", async () => {
  const previousAdminEmail = process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_EMAIL;

  try {
    const res = createJsonResponse();
    const authorized = await authorizeQuoteCacheTrimRequest(
      { refreshDailyCron: false, auth: { userId: "user-1" } },
      res,
    );

    assert.equal(authorized, false);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, {
      error: "ADMIN_EMAIL is not configured on the server",
    });
  } finally {
    if (previousAdminEmail === undefined) {
      delete process.env.ADMIN_EMAIL;
    } else {
      process.env.ADMIN_EMAIL = previousAdminEmail;
    }
  }
});

test("quote-cache trim accepts cron auth without admin lookup", async () => {
  const res = createJsonResponse();
  const authorized = await authorizeQuoteCacheTrimRequest(
    { refreshDailyCron: true, auth: { userId: null } },
    res,
  );

  assert.equal(authorized, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, undefined);
});

test("quote-cache trim count parser rejects partial numeric input", () => {
  assert.equal(parseQuoteCacheTrimKeepCount(undefined), undefined);
  assert.equal(parseQuoteCacheTrimKeepCount(""), undefined);
  assert.equal(parseQuoteCacheTrimKeepCount("25"), 25);
  assert.equal(parseQuoteCacheTrimKeepCount(0), 0);

  assert.equal(parseQuoteCacheTrimKeepCount("0x10"), null);
  assert.equal(parseQuoteCacheTrimKeepCount("10 rows"), null);
  assert.equal(parseQuoteCacheTrimKeepCount("1.5"), null);
  assert.equal(parseQuoteCacheTrimKeepCount("-1"), null);
});

test("quote-cache trim preserves latest quote per instrument when deleting old rows", async () => {
  const executeRawCalls = [];
  let countCalls = 0;
  const fakePrisma = {
    quoteCache: {
      async count() {
        countCalls += 1;
        return countCalls === 1 ? 12 : 5;
      },
    },
    async $executeRaw(...args) {
      executeRawCalls.push(args);
      return { count: 7 };
    },
  };

  const result = await trimQuoteCacheRows(4, fakePrisma);

  assert.equal(executeRawCalls.length, 1);
  const [strings, limitValue] = executeRawCalls[0];
  const sql = Array.from(strings).join("?");
  assert.match(sql, /LEFT JOIN QuoteCache newer/);
  assert.match(sql, /newer\.instrumentId = per_instrument\.instrumentId/);
  assert.match(sql, /WHERE newer\.id IS NULL/);
  assert.match(sql, /UNION/);
  assert.match(sql, /ORDER BY createdAt DESC, asOf DESC, id DESC LIMIT/);
  assert.equal(limitValue, 4);
  assert.deepEqual(result, {
    ok: true,
    keepMostRecentCount: 4,
    keepLatestPerInstrument: true,
    rowsBefore: 12,
    rowsDeleted: 7,
    rowsAfter: 5,
  });
});

test("quote-cache trim still allows explicit zero-row delete for authorized callers", async () => {
  let deleteManyCalled = false;
  const fakePrisma = {
    quoteCache: {
      async count() {
        return 3;
      },
      async deleteMany(where) {
        assert.deepEqual(where, {});
        deleteManyCalled = true;
        return { count: 3 };
      },
    },
    async $executeRaw() {
      throw new Error("raw delete should not run for explicit zero trim");
    },
  };

  const result = await trimQuoteCacheRows(0, fakePrisma);

  assert.equal(deleteManyCalled, true);
  assert.deepEqual(result, {
    ok: true,
    keepMostRecentCount: 0,
    keepLatestPerInstrument: false,
    rowsBefore: 3,
    rowsDeleted: 3,
    rowsAfter: 0,
  });
});
