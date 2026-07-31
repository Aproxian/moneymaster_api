"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PRODUCT_ID_ANNUAL,
  PRODUCT_ID_LIFETIME,
  computePremiumStateFromEvent,
} = require("../src/lib/revenuecat");

const prismaModulePath = require.resolve("../src/prisma");
require.cache[prismaModulePath] = {
  id: prismaModulePath,
  filename: prismaModulePath,
  loaded: true,
  exports: { prisma: {} },
};

const {
  applyPremiumStateEvent,
  NoMatchingRevenueCatUserError,
} = require("../src/routes/webhooks");

function uniqueConstraintError() {
  const err = new Error("Unique constraint failed");
  err.code = "P2002";
  return err;
}

function selectFields(row, select) {
  if (!select) return { ...row };
  const out = {};
  for (const key of Object.keys(select)) {
    if (select[key]) out[key] = row[key];
  }
  return out;
}

function cloneMap(map) {
  return new Map([...map].map(([key, value]) => [key, { ...value }]));
}

function makeMockPrisma() {
  const state = {
    events: new Map(),
    users: new Map(),
    failNextUpdate: false,
  };

  function clientFor(store) {
    return {
      revenueCatEvent: {
        async create({ data }) {
          if (store.events.has(data.id)) throw uniqueConstraintError();
          store.events.set(data.id, { ...data });
          return { ...data };
        },
      },
      user: {
        async findUnique({ where, select }) {
          const user = store.users.get(where.id);
          return user ? selectFields(user, select) : null;
        },
        async updateMany({ where, data }) {
          if (state.failNextUpdate) {
            state.failNextUpdate = false;
            throw new Error("simulated user update failure");
          }

          const user = store.users.get(where.id);
          if (!user) return { count: 0 };
          store.users.set(where.id, { ...user, ...data });
          return { count: 1 };
        },
      },
    };
  }

  const root = clientFor(state);
  root.state = state;
  root.$transaction = async (fn) => {
    const txStore = {
      events: cloneMap(state.events),
      users: cloneMap(state.users),
    };
    const result = await fn(clientFor(txStore));
    state.events = txStore.events;
    state.users = txStore.users;
    return result;
  };

  return root;
}

test("premium webhook idempotency record rolls back when the user update fails", async () => {
  const prisma = makeMockPrisma();
  prisma.state.users.set("user_1", { id: "user_1", premiumIsLifetime: false });

  const event = {
    id: "evt_initial",
    type: "INITIAL_PURCHASE",
    app_user_id: "user_1",
    product_id: PRODUCT_ID_ANNUAL,
    expiration_at_ms: Date.now() + 86_400_000,
  };
  const state = computePremiumStateFromEvent(event);

  prisma.state.failNextUpdate = true;
  await assert.rejects(
    () =>
      applyPremiumStateEvent(prisma, {
        eventId: event.id,
        appUserId: event.app_user_id,
        type: event.type,
        state,
      }),
    /simulated user update failure/,
  );

  assert.equal(prisma.state.events.has(event.id), false);

  const result = await applyPremiumStateEvent(prisma, {
    eventId: event.id,
    appUserId: event.app_user_id,
    type: event.type,
    state,
  });

  assert.equal(result.applied, true);
  assert.equal(prisma.state.events.has(event.id), true);
  assert.equal(prisma.state.users.get("user_1").premiumActive, true);
});

test("grant events for a missing user are retryable and are not deduped", async () => {
  const prisma = makeMockPrisma();
  const event = {
    id: "evt_missing_user",
    type: "INITIAL_PURCHASE",
    app_user_id: "missing_user",
    product_id: PRODUCT_ID_ANNUAL,
    expiration_at_ms: Date.now() + 86_400_000,
  };

  await assert.rejects(
    () =>
      applyPremiumStateEvent(prisma, {
        eventId: event.id,
        appUserId: event.app_user_id,
        type: event.type,
        state: computePremiumStateFromEvent(event),
      }),
    NoMatchingRevenueCatUserError,
  );

  assert.equal(prisma.state.events.has(event.id), false);
});

test("subscription revokes do not overwrite an existing lifetime purchase", async () => {
  const prisma = makeMockPrisma();
  prisma.state.users.set("user_1", {
    id: "user_1",
    premiumActive: true,
    premiumIsLifetime: true,
    premiumProductId: PRODUCT_ID_LIFETIME,
  });

  const event = {
    id: "evt_old_annual_expiration",
    type: "EXPIRATION",
    app_user_id: "user_1",
    product_id: PRODUCT_ID_ANNUAL,
    expiration_at_ms: Date.now() - 1_000,
  };

  const result = await applyPremiumStateEvent(prisma, {
    eventId: event.id,
    appUserId: event.app_user_id,
    type: event.type,
    state: computePremiumStateFromEvent(event),
  });

  assert.equal(result.applied, false);
  assert.equal(result.reason, "existing_lifetime_preserved");
  assert.equal(prisma.state.events.has(event.id), true);
  assert.equal(prisma.state.users.get("user_1").premiumActive, true);
  assert.equal(prisma.state.users.get("user_1").premiumIsLifetime, true);
  assert.equal(prisma.state.users.get("user_1").premiumProductId, PRODUCT_ID_LIFETIME);
});

test("customer-support cancellation revokes a lifetime purchase", async () => {
  const prisma = makeMockPrisma();
  prisma.state.users.set("user_1", {
    id: "user_1",
    premiumActive: true,
    premiumIsLifetime: true,
    premiumProductId: PRODUCT_ID_LIFETIME,
  });

  const event = {
    id: "evt_lifetime_refund",
    type: "CANCELLATION",
    app_user_id: "user_1",
    product_id: PRODUCT_ID_LIFETIME,
    cancel_reason: "CUSTOMER_SUPPORT",
  };
  const state = computePremiumStateFromEvent(event);

  assert.equal(state.active, false);
  assert.equal(state.isLifetime, true);

  const result = await applyPremiumStateEvent(prisma, {
    eventId: event.id,
    appUserId: event.app_user_id,
    type: event.type,
    state,
  });

  assert.equal(result.applied, true);
  assert.equal(prisma.state.users.get("user_1").premiumActive, false);
  assert.equal(prisma.state.users.get("user_1").premiumIsLifetime, false);
});
