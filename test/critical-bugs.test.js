const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const express = require("express");
const jwt = require("jsonwebtoken");

const SRC_PREFIX = `${process.cwd()}/src/`;

function clearSrcModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_PREFIX)) {
      delete require.cache[key];
    }
  }
}

function installPrismaStub(prisma) {
  const prismaPath = require.resolve("../src/prisma");
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: { prisma },
  };
}

async function request(app, path, options = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
    const text = await response.text();
    return {
      status: response.status,
      body: text ? JSON.parse(text) : null,
    };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

function jsonErrorHandler(err, _req, res, _next) {
  res.status(err.statusCode || 500).json({ error: err.message });
}

test("investment maintenance JWT requests fail closed when ADMIN_EMAIL is unset", async (t) => {
  const previous = {
    adminEmail: process.env.ADMIN_EMAIL,
    jwtSecret: process.env.JWT_ACCESS_SECRET,
    cronSecret: process.env.INVESTMENTS_CRON_SECRET,
  };
  t.after(() => {
    process.env.ADMIN_EMAIL = previous.adminEmail;
    process.env.JWT_ACCESS_SECRET = previous.jwtSecret;
    process.env.INVESTMENTS_CRON_SECRET = previous.cronSecret;
    clearSrcModules();
  });

  delete process.env.ADMIN_EMAIL;
  delete process.env.INVESTMENTS_CRON_SECRET;
  process.env.JWT_ACCESS_SECRET = "test_access_secret";

  let deleteManyCalls = 0;
  clearSrcModules();
  installPrismaStub({
    user: {
      findFirst: async () => ({ id: "user_1" }),
      findUnique: async () => ({ id: "user_1", email: "user@example.com" }),
    },
    quoteCache: {
      count: async () => 12,
      deleteMany: async () => {
        deleteManyCalls += 1;
        return { count: 12 };
      },
    },
    instrument: { count: async () => 12 },
  });

  const { investmentsRouter } = require("../src/routes/investments");
  const app = express();
  app.use(express.json());
  app.use("/investments", investmentsRouter);
  app.use(jsonErrorHandler);

  const token = jwt.sign({ userId: "user_1" }, "test_access_secret");
  const response = await request(app, "/investments/quote-cache/trim", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ keepMostRecentCount: 0 }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.error, "ADMIN_EMAIL is not configured on the server");
  assert.equal(deleteManyCalls, 0);
});

test("RevenueCat retries are not deduped when the premium update fails", async (t) => {
  const previousSecret = process.env.REVENUECAT_WEBHOOK_AUTH;
  t.after(() => {
    process.env.REVENUECAT_WEBHOOK_AUTH = previousSecret;
    clearSrcModules();
  });

  process.env.REVENUECAT_WEBHOOK_AUTH = "webhook-secret";
  let eventCreates = 0;
  let userUpdates = 0;

  clearSrcModules();
  installPrismaStub({
    $transaction: async (fn) =>
      fn({
        revenueCatEvent: {
          create: async () => {
            eventCreates += 1;
          },
        },
        user: {
          updateMany: async () => {
            userUpdates += 1;
            throw new Error("transient database failure");
          },
        },
      }),
  });

  const { webhooksRouter } = require("../src/routes/webhooks");
  const app = express();
  app.use(express.json());
  app.use("/webhooks", webhooksRouter);
  app.use(jsonErrorHandler);

  const response = await request(app, "/webhooks/revenuecat", {
    method: "POST",
    headers: {
      authorization: "webhook-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      event: {
        id: "evt_initial_purchase",
        type: "INITIAL_PURCHASE",
        app_user_id: "user_1",
        entitlement_ids: ["full_access"],
        product_id: "moneymaster_annual",
        expiration_at_ms: Date.now() + 60_000,
      },
    }),
  });

  assert.equal(response.status, 500);
  assert.equal(eventCreates, 1);
  assert.equal(userUpdates, 1);
});

test("RevenueCat duplicate event ids are acknowledged without reapplying", async (t) => {
  const previousSecret = process.env.REVENUECAT_WEBHOOK_AUTH;
  t.after(() => {
    process.env.REVENUECAT_WEBHOOK_AUTH = previousSecret;
    clearSrcModules();
  });

  process.env.REVENUECAT_WEBHOOK_AUTH = "webhook-secret";
  let userUpdates = 0;
  const uniqueError = new Error("Unique constraint failed");
  uniqueError.code = "P2002";

  clearSrcModules();
  installPrismaStub({
    $transaction: async (fn) =>
      fn({
        revenueCatEvent: {
          create: async () => {
            throw uniqueError;
          },
        },
        user: {
          updateMany: async () => {
            userUpdates += 1;
            return { count: 1 };
          },
        },
      }),
  });

  const { webhooksRouter } = require("../src/routes/webhooks");
  const app = express();
  app.use(express.json());
  app.use("/webhooks", webhooksRouter);
  app.use(jsonErrorHandler);

  const response = await request(app, "/webhooks/revenuecat", {
    method: "POST",
    headers: {
      authorization: "webhook-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      event: {
        id: "evt_duplicate",
        type: "INITIAL_PURCHASE",
        app_user_id: "user_1",
        entitlement_ids: ["full_access"],
        product_id: "moneymaster_annual",
        expiration_at_ms: Date.now() + 60_000,
      },
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.deduped, true);
  assert.equal(userUpdates, 0);
});

test("RevenueCat refund cancellations revoke lifetime access", () => {
  clearSrcModules();
  const { computePremiumStateFromEvent } = require("../src/lib/revenuecat");

  const state = computePremiumStateFromEvent({
    type: "CANCELLATION",
    product_id: "moneymaster_lifetime",
    cancel_reason: "CUSTOMER_SUPPORT",
    expiration_at_ms: null,
  });

  assert.equal(state.active, false);
  assert.equal(state.isLifetime, true);
  assert.equal(state.willRenew, false);
});

test("inactive lifetime rows do not satisfy premium enforcement", async (t) => {
  const previous = {
    enforcement: process.env.PREMIUM_ENFORCEMENT_ENABLED,
    adminEmail: process.env.ADMIN_EMAIL,
  };
  t.after(() => {
    process.env.PREMIUM_ENFORCEMENT_ENABLED = previous.enforcement;
    process.env.ADMIN_EMAIL = previous.adminEmail;
    clearSrcModules();
  });

  process.env.PREMIUM_ENFORCEMENT_ENABLED = "true";
  process.env.ADMIN_EMAIL = "admin@example.com";

  clearSrcModules();
  installPrismaStub({
    user: {
      findFirst: async () => ({
        email: "user@example.com",
        premiumActive: false,
        premiumIsLifetime: true,
        premiumExpiresAt: null,
      }),
    },
  });

  const { requirePremium } = require("../src/middleware/requirePremium");
  const req = { auth: { userId: "user_1" } };
  let statusCode = null;
  let body = null;
  let nextCalled = false;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };

  await requirePremium(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 402);
  assert.equal(body.code, "PREMIUM_REQUIRED");
});

test("scheduled investment buys restore previously soft-deleted holdings", async () => {
  clearSrcModules();
  const { materializeScheduledPayload } = require("../src/services/materializeScheduledPayload");

  let upsertArgs = null;
  const tx = {
    account: {
      findFirst: async () => ({
        id: "acct_1",
        currency: "EUR",
        investingEnabled: true,
        walletsEnabled: false,
      }),
    },
    user: {
      findUnique: async () => ({ personalAccountId: "acct_1" }),
    },
    instrument: {
      findFirst: async () => ({
        id: "inst_1",
        name: "Example ETF",
        providerSymbol: "ETF",
      }),
    },
    category: {
      findFirst: async () => ({
        id: "cat_1",
        type: "INVESTMENT",
        internalKey: null,
        lockedForManualEntry: false,
        memberAccessRestricted: false,
      }),
    },
    transaction: {
      create: async () => ({ id: "tx_1" }),
    },
    holding: {
      upsert: async (args) => {
        upsertArgs = args;
        return { id: "holding_1" };
      },
    },
    auditLog: {
      create: async () => ({}),
    },
  };

  await materializeScheduledPayload(tx, {
    accountId: "acct_1",
    userId: "user_1",
    occurredAt: new Date("2026-07-01T00:00:00Z"),
    payload: {
      tab: "invest",
      amountMinor: 1000,
      categoryId: "cat_1",
      instrumentId: "inst_1",
      quantity: 2,
    },
    scheduleKind: "RECURRING",
  });

  assert.equal(upsertArgs.update.deletedAt, null);
});
