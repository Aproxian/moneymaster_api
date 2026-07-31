"use strict";

const { Router } = require("express");

const { prisma } = require("../prisma");
const { logApp } = require("../lib/fileLogger");
const { timingSafeEqualUtf8 } = require("../lib/investmentsRefreshCron");
const {
  getWebhookAuthSecret,
  concernsFullAccess,
  computePremiumStateFromEvent,
} = require("../lib/revenuecat");

const webhooksRouter = Router();

function isUniqueConstraintError(err) {
  return err?.code === "P2002";
}

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

    // Idempotency: RevenueCat retries deliveries. For events that mutate users, record the event
    // in the same transaction as the mutation so a transient write failure remains retryable.
    const already = await prisma.revenueCatEvent.findUnique({ where: { id: eventId } });
    if (already) {
      return res.json({ ok: true, deduped: true });
    }

    // Only `full_access` events and identified (non-anonymous) users change premium state.
    const anonymous = !appUserId || appUserId.startsWith("$RCAnonymousID:");
    if (anonymous || !concernsFullAccess(event)) {
      try {
        await prisma.revenueCatEvent.create({ data: { id: eventId, userId: appUserId, type } });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return res.json({ ok: true, deduped: true });
        }
        throw err;
      }
      return res.json({ ok: true, applied: false, reason: "no_matching_user_or_entitlement" });
    }

    const state = computePremiumStateFromEvent(event);
    if (state.active === null) {
      // Indeterminate (TEST/TRANSFER/unknown): acknowledge without mutating the user.
      try {
        await prisma.revenueCatEvent.create({ data: { id: eventId, userId: appUserId, type } });
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          return res.json({ ok: true, deduped: true });
        }
        throw err;
      }
      return res.json({ ok: true, applied: false, reason: "indeterminate", type });
    }

    let updated;
    try {
      updated = await prisma.$transaction(async (tx) => {
        const duplicate = await tx.revenueCatEvent.findUnique({ where: { id: eventId } });
        if (duplicate) return { count: null, deduped: true };

        const userUpdate = await tx.user.updateMany({
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

        await tx.revenueCatEvent.create({ data: { id: eventId, userId: appUserId, type } });
        return { count: userUpdate.count, deduped: false };
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return res.json({ ok: true, deduped: true });
      }
      throw err;
    }

    if (updated.deduped) {
      return res.json({ ok: true, deduped: true });
    }

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
