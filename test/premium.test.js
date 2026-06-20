const test = require("node:test");
const assert = require("node:assert/strict");

const { PRODUCT_ID_LIFETIME, computePremiumStateFromEvent } = require("../src/lib/revenuecat");
const { hasActivePremium } = require("../src/middleware/requirePremium");

test("revoked lifetime purchase does not grant premium access", () => {
  const state = computePremiumStateFromEvent({
    type: "EXPIRATION",
    product_id: PRODUCT_ID_LIFETIME,
  });

  assert.equal(state.active, false);
  assert.equal(state.isLifetime, false);
  assert.equal(
    hasActivePremium({
      premiumActive: state.active,
      premiumIsLifetime: true,
      premiumExpiresAt: null,
    }),
    false
  );
});

test("active lifetime purchase grants premium access", () => {
  const state = computePremiumStateFromEvent({
    type: "INITIAL_PURCHASE",
    product_id: PRODUCT_ID_LIFETIME,
  });

  assert.equal(state.active, true);
  assert.equal(state.isLifetime, true);
  assert.equal(
    hasActivePremium({
      premiumActive: state.active,
      premiumIsLifetime: state.isLifetime,
      premiumExpiresAt: null,
    }),
    true
  );
});
