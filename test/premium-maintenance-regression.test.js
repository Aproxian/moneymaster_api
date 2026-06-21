"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const jwt = require("jsonwebtoken");

process.env.JWT_ACCESS_SECRET = "test_access_secret";
process.env.PREMIUM_ENFORCEMENT_ENABLED = "1";
process.env.INVESTMENTS_CRON_SECRET = "test_cron_secret";
delete process.env.ADMIN_EMAIL;

const mockState = {
  userFindFirstCalls: [],
  quoteCountResponses: [],
  rawSql: "",
};

function resetMockState() {
  mockState.userFindFirstCalls = [];
  mockState.quoteCountResponses = [];
  mockState.rawSql = "";
}

const mockPrisma = {
  user: {
    findFirst: async (args) => {
      mockState.userFindFirstCalls.push(args);
      if (args?.select?.premiumActive) {
        return {
          email: "user@example.com",
          premiumActive: false,
          premiumIsLifetime: false,
          premiumExpiresAt: null,
        };
      }
      return { id: "user_1" };
    },
    findUnique: async () => ({ personalAccountId: null }),
  },
  account: {
    findMany: async () => [],
  },
  quoteCache: {
    count: async () => mockState.quoteCountResponses.shift() ?? 0,
  },
  $executeRaw: async (strings, ...values) => {
    mockState.rawSql = String.raw({ raw: strings }, ...values);
    return { count: 0 };
  },
};

const prismaPath = require.resolve("../src/prisma");
require.cache[prismaPath] = {
  id: prismaPath,
  filename: prismaPath,
  loaded: true,
  exports: { prisma: mockPrisma },
};

const { app } = require("../src/app");
const { CRON_SECRET_HEADER } = require("../src/lib/investmentsRefreshCron");
const { computePremiumStateFromEvent } = require("../src/lib/revenuecat");

function authHeaders() {
  const token = jwt.sign({ userId: "user_1" }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: "5m",
  });
  return { authorization: `Bearer ${token}` };
}

async function request(method, path, { headers = {}, body } = {}) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, json };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("account list remains available for non-premium bootstrap", async () => {
  resetMockState();

  const res = await request("GET", "/accounts", { headers: authHeaders() });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { accounts: [], personalAccountId: null });
  assert.equal(
    mockState.userFindFirstCalls.some((args) => args?.select?.premiumActive),
    false
  );
});

test("account-specific routes are blocked for non-premium users", async () => {
  resetMockState();

  const res = await request("GET", "/accounts/account_1", { headers: authHeaders() });

  assert.equal(res.status, 402);
  assert.equal(res.json.code, "PREMIUM_REQUIRED");
  assert.equal(
    mockState.userFindFirstCalls.some((args) => args?.select?.premiumActive),
    true
  );
});

test("maintenance JWT access fails closed when ADMIN_EMAIL is not configured", async () => {
  resetMockState();

  const res = await request("POST", "/investments/quote-cache/trim", {
    headers: authHeaders(),
    body: {},
  });

  assert.equal(res.status, 503);
  assert.equal(res.json.error, "ADMIN_EMAIL is not configured on the server");
  assert.equal(mockState.rawSql, "");
});

test("quote-cache trim keeps the newest rows per instrument", async () => {
  resetMockState();
  mockState.quoteCountResponses = [4, 2];

  const res = await request("POST", "/investments/quote-cache/trim", {
    headers: { [CRON_SECRET_HEADER]: process.env.INVESTMENTS_CRON_SECRET },
    body: {},
  });

  assert.equal(res.status, 200);
  assert.equal(res.json.keepMostRecentPerInstrument, 1);
  assert.equal(res.json.rowsDeleted, 2);
  assert.match(mockState.rawSql, /PARTITION BY instrumentId/);
  assert.doesNotMatch(mockState.rawSql, /\bLIMIT\b/);
});

test("RevenueCat customer-support cancellations revoke premium immediately", () => {
  const state = computePremiumStateFromEvent({
    type: "CANCELLATION",
    cancel_reason: "CUSTOMER_SUPPORT",
    product_id: "moneymaster_annual",
    expiration_at_ms: Date.now() + 30 * 24 * 60 * 60 * 1000,
  });

  assert.equal(state.active, false);
  assert.equal(state.willRenew, false);
});
