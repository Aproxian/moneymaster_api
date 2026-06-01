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
