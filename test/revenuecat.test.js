const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PRODUCT_ID_ANNUAL,
  PRODUCT_ID_LIFETIME,
  concernsFullAccess,
  computePremiumStateFromEvent,
} = require("../src/lib/revenuecat");

test("SUBSCRIPTION_PAUSED keeps access until the current period expires", () => {
  const expiration = Date.now() + 60_000;
  const state = computePremiumStateFromEvent({
    type: "SUBSCRIPTION_PAUSED",
    product_id: PRODUCT_ID_ANNUAL,
    expiration_at_ms: expiration,
  });

  assert.equal(state.active, true);
  assert.equal(state.willRenew, false);
  assert.equal(state.expiresAt.getTime(), expiration);
});

test("events without entitlement metadata must match a known premium product", () => {
  assert.equal(
    concernsFullAccess({
      type: "EXPIRATION",
      product_id: "unrelated_product",
    }),
    false
  );
  assert.equal(
    concernsFullAccess({
      type: "INITIAL_PURCHASE",
      product_id: PRODUCT_ID_LIFETIME,
    }),
    true
  );
});

test("events with full_access entitlement are accepted", () => {
  assert.equal(
    concernsFullAccess({
      type: "RENEWAL",
      entitlement_ids: ["other", "full_access"],
    }),
    true
  );
});
