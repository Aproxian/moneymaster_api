"use strict";

const { Router } = require("express");

const { prisma } = require("../prisma");
const { logApp } = require("../lib/fileLogger");
const { timingSafeEqualUtf8 } = require("../lib/investmentsRefreshCron");
const {
  getWebhookAuthSecret,
  concernsFullAccess,
  computePremiumStateFromEvent,
  shouldApplyPremiumStateFromEvent,
} = require("../lib/revenuecat");

const webhooksRouter = Router();

/** RevenueCat sets a fixed Authorization header value; accept it with or without a "Bearer " prefix. */
function isAuthorized(req, secret) {
  const header = req.get("authorization")?.trim();
  if (!header) return false;
  if (timingSafeEqualUtf8(header, secret)) return true;
  if (header.startsWith("Bearer ")) {
    return timingSafeEqualUtf8(header.slice(7).trim(), secret);
  }
  return false;
}

/**
 * RevenueCat webhook → keep User premium columns in sync with the `full_access` entitlement.
 * Configure in RevenueCat dashboard → Project → Webhooks:
 *   URL: https://<api-host>/webhooks/revenuecat
 *   Authorization header: the value of REVENUECAT_WEBHOOK_AUTH
 */
webhooksRouter.post("/revenuecat", async (req, res, next) => {
  try {
    const secret = getWebhookAuthSecret();
    if (!secret) {
      // Fail closed: never accept unauthenticated webhooks.
      logApp("ERROR", "RevenueCat", "REVENUECAT_WEBHOOK_AUTH not configured");
      return res.status(503).json({ error: "webhook_not_configured" });
    }
    if (!isAuthorized(req, secret)) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const event = req.body?.event;
    if (!event || typeof event !== "object" || typeof event.id !== "string") {
      return res.status(400).json({ error: "invalid_payload" });
    }

    const eventId = event.id;
    const type = String(event.type || "UNKNOWN").toUpperCase();
    const appUserId = typeof event.app_user_id === "string" ? event.app_user_id : null;

    // Idempotency: RevenueCat retries deliveries. Record-first; a duplicate id short-circuits.
    const already = await prisma.revenueCatEvent.findUnique({ where: { id: eventId } });
    if (already) {
      return res.json({ ok: true, deduped: true });
    }
    await prisma.revenueCatEvent
      .create({ data: { id: eventId, userId: appUserId, type } })
      .catch(() => {
        /* race on retry: another delivery inserted it first — proceed harmlessly */
      });

    // Only `full_access` events and identified (non-anonymous) users change premium state.
    const anonymous = !appUserId || appUserId.startsWith("$RCAnonymousID:");
    if (anonymous || !concernsFullAccess(event)) {
      return res.json({ ok: true, applied: false, reason: "no_matching_user_or_entitlement" });
    }

    const state = computePremiumStateFromEvent(event);
    if (state.active === null) {
      // Indeterminate (TEST/TRANSFER/unknown): acknowledge without mutating the user.
      return res.json({ ok: true, applied: false, reason: "indeterminate", type });
    }

    const existingUser = await prisma.user.findUnique({
      where: { id: appUserId },
      select: {
        id: true,
        premiumActive: true,
        premiumIsLifetime: true,
        premiumExpiresAt: true,
      },
    });
    if (!existingUser) {
      return res.json({ ok: true, applied: false, type });
    }
    if (!shouldApplyPremiumStateFromEvent(existingUser, state)) {
      logApp("INFO", "RevenueCat", "stale premium downgrade ignored", {
        type,
        userId: appUserId,
        productId: state.productId,
      });
      return res.json({ ok: true, applied: false, reason: "stale_downgrade", type });
    }

    const updated = await prisma.user.updateMany({
      where: { id: appUserId },
      data: {
        premiumActive: state.active,
        premiumProductId: state.productId,
        premiumStore: state.store,
        premiumPeriodType: state.periodType,
        premiumExpiresAt: state.expiresAt,
        premiumWillRenew: state.willRenew,
        premiumIsLifetime: state.isLifetime,
        premiumUpdatedAt: new Date(),
        revenueCatCustomerId: appUserId,
      },
    });

    logApp("INFO", "RevenueCat", "webhook applied", {
      type,
      userId: appUserId,
      active: state.active,
      isLifetime: state.isLifetime,
      matched: updated.count,
    });

    return res.json({ ok: true, applied: updated.count > 0, type });
  } catch (err) {
    next(err);
  }
});

module.exports = { webhooksRouter };
