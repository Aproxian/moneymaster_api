const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const express = require("express");

function mockModule(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
  return resolved;
}

function loadInvestmentsRouterWithJwtCaller() {
  const mocked = [];
  mocked.push(
    mockModule("../src/middleware/refreshDailyAuth", {
      refreshDailyAuth(req, _res, next) {
        req.refreshDailyCron = false;
        req.auth = { userId: "user-1" };
        next();
      },
    })
  );
  mocked.push(
    mockModule("../src/prisma", {
      prisma: {
        user: {
          async findUnique() {
            throw new Error("user lookup should not run when ADMIN_EMAIL is missing");
          },
        },
      },
    })
  );
  mocked.push(
    mockModule("../src/services/marketData", {
      async refreshDailyQuotesForTwelveData() {
        throw new Error("quote refresh should not run for a non-admin JWT caller");
      },
    })
  );
  mocked.push(
    mockModule("../src/services/twelveDataRefreshScheduler", {
      async startTwelveDataBackgroundSweep() {
        throw new Error("sweep should not start for a non-admin JWT caller");
      },
      async stopTwelveDataBackgroundSweep() {},
      getTwelveDataBackgroundSweepStatus() {
        return {};
      },
      getTwelveDataSweepLiveStatus() {
        throw new Error("status should not load for a non-admin JWT caller");
      },
      isLocalSweepRunnerActive() {
        return false;
      },
      async requestRemoteBackgroundSweepCancel() {},
    })
  );
  mocked.push(
    mockModule("../src/lib/investmentsRefreshCron", {
      calendarDateInSweepTimezone() {
        return "2026-05-16";
      },
      SWEEP_DAY_TIMEZONE: "UTC",
      CRON_SECRET_HEADER: "x-investments-cron-secret",
    })
  );

  const routerPath = require.resolve("../src/routes/investments");
  delete require.cache[routerPath];
  const { investmentsRouter } = require("../src/routes/investments");

  return {
    investmentsRouter,
    cleanup() {
      delete require.cache[routerPath];
      for (const modulePath of mocked) delete require.cache[modulePath];
    },
  };
}

async function request(router, path, options = {}) {
  const app = express();
  app.use(express.json());
  app.use("/investments", router);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
    const body = await response.json();
    return { status: response.status, body };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("JWT refresh-daily callers fail closed when ADMIN_EMAIL is missing", async (t) => {
  const originalAdminEmail = process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_EMAIL;
  t.after(() => {
    if (originalAdminEmail === undefined) {
      delete process.env.ADMIN_EMAIL;
    } else {
      process.env.ADMIN_EMAIL = originalAdminEmail;
    }
  });

  const { investmentsRouter, cleanup } = loadInvestmentsRouterWithJwtCaller();
  t.after(cleanup);

  const response = await request(investmentsRouter, "/investments/refresh-daily", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "ADMIN_EMAIL is not configured on the server");
});

test("JWT twelve-data status callers fail closed when ADMIN_EMAIL is missing", async (t) => {
  const originalAdminEmail = process.env.ADMIN_EMAIL;
  delete process.env.ADMIN_EMAIL;
  t.after(() => {
    if (originalAdminEmail === undefined) {
      delete process.env.ADMIN_EMAIL;
    } else {
      process.env.ADMIN_EMAIL = originalAdminEmail;
    }
  });

  const { investmentsRouter, cleanup } = loadInvestmentsRouterWithJwtCaller();
  t.after(cleanup);

  const response = await request(investmentsRouter, "/investments/twelve-data-sweep-status");

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "ADMIN_EMAIL is not configured on the server");
});
