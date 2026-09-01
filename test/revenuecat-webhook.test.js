"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");

function createPrismaMock() {
  const events = new Map();
  const userUpdates = [];
  let failNextUpdate = false;

  return {
    events,
    userUpdates,
    failNextUserUpdate() {
      failNextUpdate = true;
    },
    async $transaction(callback) {
      const pendingEvents = new Map();
      const tx = {
        revenueCatEvent: {
          async findUnique({ where }) {
            return events.get(where.id) || pendingEvents.get(where.id) || null;
          },
          async create({ data }) {
            if (events.has(data.id) || pendingEvents.has(data.id)) {
              const err = new Error("Unique constraint failed");
              err.code = "P2002";
              throw err;
            }
            const row = { ...data, receivedAt: new Date() };
            pendingEvents.set(data.id, row);
            return row;
          },
        },
        user: {
          async updateMany(args) {
            if (failNextUpdate) {
              failNextUpdate = false;
              throw new Error("transient database failure");
            }
            userUpdates.push(args);
            return { count: 1 };
          },
        },
      };

      const result = await callback(tx);
      for (const [id, row] of pendingEvents) {
        events.set(id, row);
      }
      return result;
    },
  };
}

function loadRevenueCatRouter(prisma) {
  const routePath = require.resolve("../src/routes/webhooks");
  const prismaPath = require.resolve("../src/prisma");
  const loggerPath = require.resolve("../src/lib/fileLogger");
  const previousRoute = require.cache[routePath];
  const previousPrisma = require.cache[prismaPath];
  const previousLogger = require.cache[loggerPath];

  delete require.cache[routePath];
  require.cache[prismaPath] = {
    id: prismaPath,
    filename: prismaPath,
    loaded: true,
    exports: { prisma },
  };
  require.cache[loggerPath] = {
    id: loggerPath,
    filename: loggerPath,
    loaded: true,
    exports: { logApp: () => {} },
  };

  const { webhooksRouter } = require("../src/routes/webhooks");

  return {
    webhooksRouter,
    cleanup() {
      delete require.cache[routePath];
      if (previousRoute) require.cache[routePath] = previousRoute;
      if (previousPrisma) require.cache[prismaPath] = previousPrisma;
      else delete require.cache[prismaPath];
      if (previousLogger) require.cache[loggerPath] = previousLogger;
      else delete require.cache[loggerPath];
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

async function postWebhook(baseUrl, body) {
  const res = await fetch(`${baseUrl}/revenuecat`, {
    method: "POST",
    headers: {
      authorization: "webhook-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test("RevenueCat retry can apply after a failed premium update", async (t) => {
  const oldSecret = process.env.REVENUECAT_WEBHOOK_AUTH;
  process.env.REVENUECAT_WEBHOOK_AUTH = "webhook-secret";
  t.after(() => {
    if (oldSecret === undefined) delete process.env.REVENUECAT_WEBHOOK_AUTH;
    else process.env.REVENUECAT_WEBHOOK_AUTH = oldSecret;
  });

  const prisma = createPrismaMock();
  const { webhooksRouter, cleanup } = loadRevenueCatRouter(prisma);
  t.after(cleanup);

  const app = express();
  app.use(express.json());
  app.use(webhooksRouter);
  app.use((err, _req, res, _next) => {
    res.status(500).json({ error: err.message });
  });

  const payload = {
    event: {
      id: "evt_retry_after_failure",
      type: "EXPIRATION",
      app_user_id: "user_1",
      entitlement_ids: ["full_access"],
      product_id: "moneymaster_annual",
      expiration_at_ms: Date.now() - 1000,
    },
  };

  await withServer(app, async (baseUrl) => {
    prisma.failNextUserUpdate();
    const failed = await postWebhook(baseUrl, payload);
    assert.equal(failed.status, 500);
    assert.equal(prisma.events.has("evt_retry_after_failure"), false);
    assert.equal(prisma.userUpdates.length, 0);

    const retried = await postWebhook(baseUrl, payload);
    assert.equal(retried.status, 200);
    assert.deepEqual(retried.body, {
      ok: true,
      applied: true,
      type: "EXPIRATION",
    });
    assert.equal(prisma.events.has("evt_retry_after_failure"), true);
    assert.equal(prisma.userUpdates.length, 1);
    assert.equal(prisma.userUpdates[0].data.premiumActive, false);

    const duplicate = await postWebhook(baseUrl, payload);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(duplicate.body, { ok: true, deduped: true });
    assert.equal(prisma.userUpdates.length, 1);
  });
});
