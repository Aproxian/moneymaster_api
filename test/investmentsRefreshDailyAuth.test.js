const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const express = require("express");

const investmentsPath = require.resolve("../src/routes/investments");
const prismaPath = require.resolve("../src/prisma");
const authPath = require.resolve("../src/middleware/auth");
const marketDataPath = require.resolve("../src/services/marketData");
const schedulerPath = require.resolve("../src/services/twelveDataRefreshScheduler");

function stubModule(path, exports) {
  require.cache[path] = {
    id: path,
    filename: path,
    loaded: true,
    exports,
  };
}

function loadInvestmentsRouter({ userEmail = "user@example.com" } = {}) {
  delete require.cache[investmentsPath];

  const calls = { refreshDaily: 0 };

  stubModule(prismaPath, {
    prisma: {
      user: {
        findUnique: async () => ({ id: "user-1", email: userEmail }),
      },
      auditLog: {
        create: async () => ({}),
      },
    },
  });
  stubModule(authPath, {
    requireAuth: (_req, _res, next) => {
      _req.auth = { userId: "user-1" };
      next();
    },
  });
  stubModule(marketDataPath, {
    refreshDailyQuotesForTwelveData: async () => {
      calls.refreshDaily += 1;
      return {
        mode: "chunk",
        instrumentsCount: 0,
        quotesCreated: 0,
      };
    },
  });
  stubModule(schedulerPath, {
    startTwelveDataBackgroundSweep: async () => ({ ok: true }),
    stopTwelveDataBackgroundSweep: () => {},
    getTwelveDataBackgroundSweepStatus: () => ({ running: false }),
  });

  const { investmentsRouter } = require(investmentsPath);
  return { investmentsRouter, calls };
}

async function withServer(router, fn) {
  const app = express();
  app.use(express.json());
  app.use("/investments", router);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function postJson(baseUrl, path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            body: data ? JSON.parse(data) : null,
          });
        });
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

test.afterEach(() => {
  delete require.cache[investmentsPath];
  delete require.cache[prismaPath];
  delete require.cache[authPath];
  delete require.cache[marketDataPath];
  delete require.cache[schedulerPath];
  delete process.env.ADMIN_EMAIL;
});

test("refresh-daily fails closed when ADMIN_EMAIL is not configured", async () => {
  process.env.ADMIN_EMAIL = "";
  const { investmentsRouter, calls } = loadInvestmentsRouter();

  await withServer(investmentsRouter, async (baseUrl) => {
    const res = await postJson(baseUrl, "/investments/refresh-daily", {});
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, "ADMIN_EMAIL is not configured on the server");
    assert.equal(calls.refreshDaily, 0);
  });
});

test("refresh-daily rejects authenticated non-admin users", async () => {
  process.env.ADMIN_EMAIL = "admin@example.com";
  const { investmentsRouter, calls } = loadInvestmentsRouter({ userEmail: "user@example.com" });

  await withServer(investmentsRouter, async (baseUrl) => {
    const res = await postJson(baseUrl, "/investments/refresh-daily", {});
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.error, "Not allowed to perform this operation");
    assert.equal(calls.refreshDaily, 0);
  });
});

test("refresh-daily allows the configured admin user", async () => {
  process.env.ADMIN_EMAIL = "admin@example.com";
  const { investmentsRouter, calls } = loadInvestmentsRouter({ userEmail: "admin@example.com" });

  await withServer(investmentsRouter, async (baseUrl) => {
    const res = await postJson(baseUrl, "/investments/refresh-daily", {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.provider, "TWELVEDATA");
    assert.equal(calls.refreshDaily, 1);
  });
});
