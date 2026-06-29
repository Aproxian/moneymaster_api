"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");

function setMock(resolvedPath, exports) {
  const previous = require.cache[resolvedPath];
  require.cache[resolvedPath] = {
    id: resolvedPath,
    filename: resolvedPath,
    loaded: true,
    exports,
  };
  return () => {
    if (previous) require.cache[resolvedPath] = previous;
    else delete require.cache[resolvedPath];
  };
}

function resetModule(resolvedPath) {
  const previous = require.cache[resolvedPath];
  delete require.cache[resolvedPath];
  return () => {
    delete require.cache[resolvedPath];
    if (previous) require.cache[resolvedPath] = previous;
  };
}

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

async function withServer(app, run) {
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const { port } = server.address();
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("accounts root remains bootstrap-accessible while account-specific routes require premium", async (t) => {
  const accountsPath = require.resolve("../src/routes/accounts");
  const prismaPath = require.resolve("../src/prisma");
  const authPath = require.resolve("../src/middleware/auth");
  const premiumPath = require.resolve("../src/middleware/requirePremium");
  const cleanups = [
    resetModule(accountsPath),
    setMock(prismaPath, {
      prisma: {
        user: {
          async findUnique() {
            return { personalAccountId: null };
          },
        },
        account: {
          async findMany() {
            return [];
          },
        },
      },
    }),
    setMock(authPath, {
      requireAuth(req, _res, next) {
        req.auth = { userId: "user_1" };
        next();
      },
    }),
    setMock(premiumPath, {
      requirePremium(_req, res) {
        res.status(402).json({ code: "PREMIUM_REQUIRED" });
      },
    }),
  ];
  t.after(() => cleanups.reverse().forEach((cleanup) => cleanup()));

  const { accountsRouter } = require("../src/routes/accounts");
  const app = express();
  app.use(express.json());
  app.use("/accounts", accountsRouter);

  await withServer(app, async (baseUrl) => {
    const root = await fetch(`${baseUrl}/accounts`);
    assert.equal(root.status, 200);
    assert.deepEqual(await root.json(), { accounts: [], personalAccountId: null });

    const accountSpecific = await fetch(`${baseUrl}/accounts/acc_1`);
    assert.equal(accountSpecific.status, 402);
    assert.deepEqual(await accountSpecific.json(), { code: "PREMIUM_REQUIRED" });
  });
});

test("quote-cache trim fails closed for non-cron callers without ADMIN_EMAIL", async (t) => {
  const investmentsPath = require.resolve("../src/routes/investments");
  const prismaPath = require.resolve("../src/prisma");
  const cleanups = [
    resetModule(investmentsPath),
    setMock(prismaPath, { prisma: {} }),
  ];
  const previousAdminEmail = process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_EMAIL;
  t.after(() => {
    cleanups.reverse().forEach((cleanup) => cleanup());
    if (previousAdminEmail === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = previousAdminEmail;
  });

  const {
    __private: { authorizeQuoteCacheTrimRequest },
  } = require("../src/routes/investments");

  const res = createJsonResponse();
  const authorized = await authorizeQuoteCacheTrimRequest(
    { refreshDailyCron: false, auth: { userId: "user_1" } },
    res,
  );

  assert.equal(authorized, false);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: "ADMIN_EMAIL is not configured on the server" });
});

test("quote-cache trim preserves latest quote per instrument when deleting old rows", async (t) => {
  const investmentsPath = require.resolve("../src/routes/investments");
  const prismaPath = require.resolve("../src/prisma");
  const cleanups = [
    resetModule(investmentsPath),
    setMock(prismaPath, { prisma: {} }),
  ];
  t.after(() => cleanups.reverse().forEach((cleanup) => cleanup()));

  const {
    __private: { parseQuoteCacheTrimKeepCount, trimQuoteCacheRows },
  } = require("../src/routes/investments");

  assert.equal(parseQuoteCacheTrimKeepCount("25"), 25);
  assert.equal(parseQuoteCacheTrimKeepCount("10 rows"), null);
  assert.equal(parseQuoteCacheTrimKeepCount("-1"), null);

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

test("schedule materialization no-ops for non-premium users when enforcement is enabled", async (t) => {
  const servicePath = require.resolve("../src/services/processPendingSchedules");
  const prismaPath = require.resolve("../src/prisma");
  const premiumPath = require.resolve("../src/middleware/requirePremium");
  const loggerPath = require.resolve("../src/lib/fileLogger");
  let scheduleQueryCount = 0;
  const cleanups = [
    resetModule(servicePath),
    setMock(prismaPath, {
      prisma: {
        user: {
          async findFirst() {
            return {
              email: "user@example.com",
              premiumActive: false,
              premiumIsLifetime: false,
              premiumExpiresAt: null,
            };
          },
        },
        pendingTransactionSchedule: {
          async findMany() {
            scheduleQueryCount += 1;
            return [];
          },
        },
      },
    }),
    setMock(premiumPath, {
      hasActivePremium() {
        return false;
      },
      isPremiumEnforcementEnabled() {
        return true;
      },
    }),
    setMock(loggerPath, { logApp: () => {} }),
  ];
  t.after(() => cleanups.reverse().forEach((cleanup) => cleanup()));

  const { processPendingSchedulesForUser } = require("../src/services/processPendingSchedules");
  await processPendingSchedulesForUser("user_1");
  assert.equal(scheduleQueryCount, 0);
});
