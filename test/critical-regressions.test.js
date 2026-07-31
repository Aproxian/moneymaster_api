const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

const jwt = require("jsonwebtoken");

const SRC_ROOT = path.resolve(__dirname, "../src") + path.sep;
const ACCESS_SECRET = "dev_access_secret_change_me";

function clearSrcRequireCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_ROOT)) {
      delete require.cache[key];
    }
  }
}

function loadAppWithPrisma(prisma) {
  clearSrcRequireCache();
  const prismaPath = require.resolve("../src/prisma");
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: { prisma },
    children: [],
    paths: module.paths,
  };
  return require("../src/app").app;
}

function authHeader() {
  const token = jwt.sign({ userId: "user_1" }, ACCESS_SECRET);
  return `Bearer ${token}`;
}

function createPrismaMock({ premiumUser } = {}) {
  const calls = {
    premiumLookups: 0,
    quoteCacheCount: 0,
    quoteCacheDeleteMany: 0,
  };
  const now = new Date("2026-01-01T00:00:00.000Z");

  const prisma = {
    user: {
      async findFirst(args = {}) {
        if (args.select?.premiumActive !== undefined) {
          calls.premiumLookups += 1;
          return (
            premiumUser ?? {
              email: "user@example.com",
              premiumActive: false,
              premiumIsLifetime: false,
              premiumExpiresAt: null,
            }
          );
        }
        return { id: "user_1" };
      },
      async findUnique(args = {}) {
        if (args.select?.personalAccountId) return { personalAccountId: null };
        return { id: "user_1", email: "user@example.com" };
      },
    },
    account: {
      async findMany() {
        return [];
      },
      async findFirst() {
        return {
          id: "acct_1",
          name: "Main",
          currency: "EUR",
          investingEnabled: true,
          walletsEnabled: false,
          walletMigrationPending: false,
          preventNegativeCashBalance: false,
          isBusiness: false,
          companyName: null,
          companyLegalName: null,
          companyTaxId: null,
          companyAddress: null,
          companyNotes: null,
          createdAt: now,
          updatedAt: now,
          wallets: [],
        };
      },
    },
    accountMember: {
      async findUnique() {
        return { role: "OWNER" };
      },
      async findMany() {
        return [];
      },
    },
    quoteCache: {
      async count() {
        calls.quoteCacheCount += 1;
        return 0;
      },
      async deleteMany() {
        calls.quoteCacheDeleteMany += 1;
        return { count: 0 };
      },
    },
    instrument: {
      async count() {
        return 0;
      },
    },
    auditLog: {
      async create() {
        return {};
      },
    },
    async $executeRaw() {
      return 0;
    },
  };

  return { prisma, calls };
}

async function request(app, method, route, { body } = {}) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: {
        authorization: authHeader(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    return { status: response.status, body: payload };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("account-specific account routes are premium gated", async () => {
  process.env.PREMIUM_ENFORCEMENT_ENABLED = "true";
  const { prisma, calls } = createPrismaMock();
  const app = loadAppWithPrisma(prisma);

  const res = await request(app, "GET", "/accounts/acct_1");

  assert.equal(res.status, 402);
  assert.equal(res.body.code, "PREMIUM_REQUIRED");
  assert.equal(calls.premiumLookups, 1);
});

test("account list remains available for bootstrap without premium", async () => {
  process.env.PREMIUM_ENFORCEMENT_ENABLED = "true";
  const { prisma, calls } = createPrismaMock();
  const app = loadAppWithPrisma(prisma);

  const res = await request(app, "GET", "/accounts");

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.accounts, []);
  assert.equal(calls.premiumLookups, 0);
});

test("quote-cache trim fails closed for non-cron callers without ADMIN_EMAIL", async () => {
  delete process.env.ADMIN_EMAIL;
  process.env.PREMIUM_ENFORCEMENT_ENABLED = "false";
  const { prisma, calls } = createPrismaMock({
    premiumUser: {
      email: "user@example.com",
      premiumActive: true,
      premiumIsLifetime: false,
      premiumExpiresAt: new Date(Date.now() + 60_000),
    },
  });
  const app = loadAppWithPrisma(prisma);

  const res = await request(
    app,
    "POST",
    "/investments/quote-cache/trim?keepMostRecentCount=0",
    { body: {} }
  );

  assert.equal(res.status, 503);
  assert.equal(res.body.error, "ADMIN_EMAIL is not configured on the server");
  assert.equal(calls.quoteCacheCount, 0);
  assert.equal(calls.quoteCacheDeleteMany, 0);
});

test("stale subscription revocations do not overwrite lifetime access", () => {
  clearSrcRequireCache();
  const {
    PRODUCT_ID_ANNUAL,
    computePremiumStateFromEvent,
    shouldApplyPremiumStateFromEvent,
  } = require("../src/lib/revenuecat");

  const state = computePremiumStateFromEvent({
    type: "EXPIRATION",
    product_id: PRODUCT_ID_ANNUAL,
    expiration_at_ms: Date.now() - 1_000,
    entitlement_ids: ["full_access"],
  });

  assert.equal(state.active, false);
  assert.equal(
    shouldApplyPremiumStateFromEvent(
      {
        premiumActive: true,
        premiumIsLifetime: true,
        premiumExpiresAt: null,
      },
      state
    ),
    false
  );
});

test("older subscription expirations do not overwrite a later active expiry", () => {
  clearSrcRequireCache();
  const {
    PRODUCT_ID_ANNUAL,
    computePremiumStateFromEvent,
    shouldApplyPremiumStateFromEvent,
  } = require("../src/lib/revenuecat");
  const oldExpiry = Date.now() - 1_000;

  const state = computePremiumStateFromEvent({
    type: "EXPIRATION",
    product_id: PRODUCT_ID_ANNUAL,
    expiration_at_ms: oldExpiry,
    entitlement_ids: ["full_access"],
  });

  assert.equal(
    shouldApplyPremiumStateFromEvent(
      {
        premiumActive: true,
        premiumIsLifetime: false,
        premiumExpiresAt: new Date(oldExpiry + 90 * 24 * 60 * 60 * 1_000),
      },
      state
    ),
    false
  );
});
