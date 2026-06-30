"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  PRODUCT_ID_ANNUAL,
  PRODUCT_ID_LIFETIME,
  concernsFullAccess,
  computePremiumStateFromEvent,
} = require("../src/lib/revenuecat");

test("ignores webhook events with no full_access entitlement or known premium product", () => {
  assert.equal(
    concernsFullAccess({
      entitlement_ids: null,
      product_id: "tip_jar",
    }),
    false
  );

  assert.equal(
    concernsFullAccess({
      product_id: "unmapped_non_renewing",
    }),
    false
  );
});

test("accepts explicit full_access entitlement and known premium products", () => {
  assert.equal(
    concernsFullAccess({
      entitlement_ids: ["full_access"],
      product_id: "unmapped_non_renewing",
    }),
    true
  );

  assert.equal(
    concernsFullAccess({
      entitlement_ids: null,
      product_id: PRODUCT_ID_ANNUAL,
    }),
    true
  );
});

test("only the lifetime product is mirrored as lifetime premium", () => {
  const annualNonRenewing = computePremiumStateFromEvent({
    type: "NON_RENEWING_PURCHASE",
    product_id: PRODUCT_ID_ANNUAL,
    expiration_at_ms: Date.now() + 60_000,
  });

  assert.equal(annualNonRenewing.active, true);
  assert.equal(annualNonRenewing.isLifetime, false);
  assert.equal(annualNonRenewing.willRenew, false);
  assert.ok(annualNonRenewing.expiresAt instanceof Date);

  const lifetime = computePremiumStateFromEvent({
    type: "NON_RENEWING_PURCHASE",
    product_id: PRODUCT_ID_LIFETIME,
  });

  assert.equal(lifetime.active, true);
  assert.equal(lifetime.isLifetime, true);
  assert.equal(lifetime.willRenew, false);
  assert.equal(lifetime.expiresAt, null);
});
