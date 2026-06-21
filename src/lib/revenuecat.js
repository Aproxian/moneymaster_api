"use strict";

/**
 * RevenueCat server-side constants and helpers.
 *
 * Entitlement / product identifiers must match the RevenueCat dashboard and the mobile app
 * (`MoneyMASTER_Mobile/lib/revenuecat.ts`).
 */
const REVENUECAT_ENTITLEMENT_ID = "full_access";
const PRODUCT_ID_ANNUAL = "moneymaster_annual";
const PRODUCT_ID_LIFETIME = "moneymaster_lifetime";

/** Header value configured in RevenueCat dashboard → Webhooks → Authorization header. */
function getWebhookAuthSecret() {
  return process.env.REVENUECAT_WEBHOOK_AUTH?.trim() || "";
}

/** Event types that immediately revoke access. */
const REVOKE_TYPES = new Set(["EXPIRATION", "SUBSCRIPTION_PAUSED"]);

/** Event types that grant access (subject to expiry for subscriptions). */
const GRANT_TYPES = new Set([
  "INITIAL_PURCHASE",
  "RENEWAL",
  "UNCANCELLATION",
  "PRODUCT_CHANGE",
  "SUBSCRIPTION_EXTENDED",
  "NON_RENEWING_PURCHASE",
  "TEMPORARY_ENTITLEMENT_GRANT",
]);

/**
 * @param {Record<string, any>} event RevenueCat webhook `event` object.
 * @returns {boolean} whether the event concerns the `full_access` entitlement.
 */
function concernsFullAccess(event) {
  const ids = Array.isArray(event?.entitlement_ids) ? event.entitlement_ids : null;
  const single = typeof event?.entitlement_id === "string" ? event.entitlement_id : null;
  if (!ids && !single) return true; // some events omit entitlement info; do not filter them out
  if (ids && ids.includes(REVENUECAT_ENTITLEMENT_ID)) return true;
  if (single && single === REVENUECAT_ENTITLEMENT_ID) return true;
  return false;
}

/**
 * Derive the user's premium state from a single webhook event.
 *
 * @param {Record<string, any>} event
 * @returns {{
 *   active: boolean | null, // null => indeterminate (caller should not change DB)
 *   isLifetime: boolean,
 *   productId: string | null,
 *   store: string | null,
 *   periodType: string | null,
 *   expiresAt: Date | null,
 *   willRenew: boolean,
 * }}
 */
function computePremiumStateFromEvent(event) {
  const type = String(event?.type || "").toUpperCase();
  const cancelReason = String(event?.cancel_reason || "").toUpperCase();
  const productId = event?.product_id ?? null;
  const store = event?.store ?? null;
  const periodType = event?.period_type ?? null;
  const expMs =
    typeof event?.expiration_at_ms === "number" ? event.expiration_at_ms : null;

  const isLifetime =
    productId === PRODUCT_ID_LIFETIME || type === "NON_RENEWING_PURCHASE";

  let active;
  if (REVOKE_TYPES.has(type) || (type === "CANCELLATION" && cancelReason === "CUSTOMER_SUPPORT")) {
    active = false;
  } else if (isLifetime) {
    active = true;
  } else if (expMs != null) {
    // Covers RENEWAL/CANCELLATION/BILLING_ISSUE/etc.: access lasts until expiry.
    active = expMs > Date.now();
  } else if (GRANT_TYPES.has(type)) {
    active = true;
  } else {
    active = null; // TRANSFER / TEST / unknown → leave DB untouched
  }

  let willRenew;
  if (isLifetime) {
    willRenew = false;
  } else if (
    type === "CANCELLATION" ||
    type === "EXPIRATION" ||
    type === "SUBSCRIPTION_PAUSED" ||
    type === "BILLING_ISSUE"
  ) {
    willRenew = false;
  } else {
    willRenew = active === true;
  }

  return {
    active,
    isLifetime,
    productId,
    store,
    periodType,
    expiresAt: isLifetime ? null : expMs != null ? new Date(expMs) : null,
    willRenew,
  };
}

module.exports = {
  REVENUECAT_ENTITLEMENT_ID,
  PRODUCT_ID_ANNUAL,
  PRODUCT_ID_LIFETIME,
  getWebhookAuthSecret,
  concernsFullAccess,
  computePremiumStateFromEvent,
};
