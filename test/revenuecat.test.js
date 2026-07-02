"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PRODUCT_ID_LIFETIME,
  computePremiumStateFromEvent,
} = require("../src/lib/revenuecat");

test("lifetime product grants lifetime premium", () => {
  const state = computePremiumStateFromEvent({
    type: "NON_RENEWING_PURCHASE",
    product_id: PRODUCT_ID_LIFETIME,
  });

  assert.equal(state.active, true);
  assert.equal(state.isLifetime, true);
  assert.equal(state.expiresAt, null);
  assert.equal(state.willRenew, false);
});

test("non-lifetime non-renewing purchase is not persisted as lifetime", () => {
  const expiresAtMs = Date.now() + 60_000;

  const state = computePremiumStateFromEvent({
    type: "NON_RENEWING_PURCHASE",
    product_id: "promo_month",
    expiration_at_ms: expiresAtMs,
  });

  assert.equal(state.active, true);
  assert.equal(state.isLifetime, false);
  assert.equal(state.expiresAt.getTime(), expiresAtMs);
  assert.equal(state.willRenew, true);
});
