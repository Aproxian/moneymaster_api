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

function isUniqueConstraintError(err) {
  return err?.code === "P2002";
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

    // Only `full_access` events and identified (non-anonymous) users change premium state.
    const anonymous = !appUserId || appUserId.startsWith("$RCAnonymousID:");
    const matchesFullAccess = concernsFullAccess(event);
    const state =
      anonymous || !matchesFullAccess ? null : computePremiumStateFromEvent(event);

    let result;
    try {
      result = await prisma.$transaction(async (tx) => {
        await tx.revenueCatEvent.create({ data: { id: eventId, userId: appUserId, type } });

        if (anonymous || !matchesFullAccess) {
          return {
            applied: false,
            reason: "no_matching_user_or_entitlement",
          };
        }

        if (state.active === null) {
          // Indeterminate (TEST/TRANSFER/unknown): acknowledge without mutating the user.
          return { applied: false, reason: "indeterminate" };
        }

        const updated = await tx.user.updateMany({
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

        return { applied: updated.count > 0, matched: updated.count };
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        return res.json({ ok: true, deduped: true });
      }
      throw err;
    }

    if (result.reason) {
      return res.json({ ok: true, applied: false, reason: result.reason, type });
    }

    logApp("INFO", "RevenueCat", "webhook applied", {
      type,
      userId: appUserId,
      active: state.active,
      isLifetime: state.isLifetime,
      matched: result.matched,
    });

    return res.json({ ok: true, applied: result.applied, type });
  } catch (err) {
    next(err);
  }
});

module.exports = { webhooksRouter };
