const assert = require("node:assert/strict");
const test = require("node:test");

const { computePremiumStateFromEvent } = require("../src/lib/revenuecat");

test("lifetime cancellation revokes access and clears lifetime bypass", () => {
  const state = computePremiumStateFromEvent({
    type: "CANCELLATION",
    product_id: "moneymaster_lifetime",
    cancel_reason: "CUSTOMER_SUPPORT",
  });

  assert.equal(state.active, false);
  assert.equal(state.isLifetime, false);
  assert.equal(state.willRenew, false);
  assert.equal(state.expiresAt, null);
});

test("subscription pause keeps access until the current expiration", () => {
  const expiration = Date.now() + 60 * 60 * 1000;
  const state = computePremiumStateFromEvent({
    type: "SUBSCRIPTION_PAUSED",
    product_id: "moneymaster_annual",
    expiration_at_ms: expiration,
  });

  assert.equal(state.active, true);
  assert.equal(state.isLifetime, false);
  assert.equal(state.willRenew, false);
  assert.equal(state.expiresAt.getTime(), expiration);
});

test("standard subscription cancellation keeps access until expiration", () => {
  const expiration = Date.now() + 60 * 60 * 1000;
  const state = computePremiumStateFromEvent({
    type: "CANCELLATION",
    product_id: "moneymaster_annual",
    cancel_reason: "UNSUBSCRIBE",
    expiration_at_ms: expiration,
  });

  assert.equal(state.active, true);
  assert.equal(state.isLifetime, false);
  assert.equal(state.willRenew, false);
  assert.equal(state.expiresAt.getTime(), expiration);
});
