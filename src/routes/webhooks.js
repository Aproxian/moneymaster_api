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

class NoMatchingRevenueCatUserError extends Error {
  constructor(userId) {
    super("RevenueCat webhook referenced a user that does not exist");
    this.name = "NoMatchingRevenueCatUserError";
    this.userId = userId;
  }
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

function isUniqueConstraintError(err) {
  return err?.code === "P2002";
}

function buildPremiumUpdateData(state, appUserId) {
  return {
    premiumActive: state.active,
    premiumProductId: state.productId,
    premiumStore: state.store,
    premiumPeriodType: state.periodType,
    premiumExpiresAt: state.expiresAt,
    premiumWillRenew: state.willRenew,
    premiumIsLifetime: state.active === true && state.isLifetime,
    premiumUpdatedAt: new Date(),
    revenueCatCustomerId: appUserId,
  };
}

async function recordRevenueCatEvent(client, { eventId, appUserId, type }) {
  try {
    await client.revenueCatEvent.create({ data: { id: eventId, userId: appUserId, type } });
    return { recorded: true };
  } catch (err) {
    if (isUniqueConstraintError(err)) return { recorded: false, deduped: true };
    throw err;
  }
}

async function applyPremiumStateEvent(client, { eventId, appUserId, type, state }) {
  try {
    return await client.$transaction(async (tx) => {
      await tx.revenueCatEvent.create({ data: { id: eventId, userId: appUserId, type } });

      const user = await tx.user.findUnique({
        where: { id: appUserId },
        select: { premiumIsLifetime: true },
      });

      if (!user) {
        if (state.active === true) {
          throw new NoMatchingRevenueCatUserError(appUserId);
        }
        return { applied: false, matched: 0, reason: "no_matching_user" };
      }

      if (user.premiumIsLifetime && !state.isLifetime) {
        return { applied: false, matched: 1, reason: "existing_lifetime_preserved" };
      }

      const updated = await tx.user.updateMany({
        where: { id: appUserId },
        data: buildPremiumUpdateData(state, appUserId),
      });

      if (updated.count === 0 && state.active === true) {
        throw new NoMatchingRevenueCatUserError(appUserId);
      }

      return { applied: updated.count > 0, matched: updated.count };
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) return { deduped: true };
    throw err;
  }
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
    if (anonymous || !concernsFullAccess(event)) {
      const recorded = await recordRevenueCatEvent(prisma, { eventId, appUserId, type });
      if (recorded.deduped) return res.json({ ok: true, deduped: true });
      return res.json({ ok: true, applied: false, reason: "no_matching_user_or_entitlement" });
    }

    const state = computePremiumStateFromEvent(event);
    if (state.active === null) {
      // Indeterminate (TEST/TRANSFER/unknown): acknowledge without mutating the user.
      const recorded = await recordRevenueCatEvent(prisma, { eventId, appUserId, type });
      if (recorded.deduped) return res.json({ ok: true, deduped: true });
      return res.json({ ok: true, applied: false, reason: "indeterminate", type });
    }

    let result;
    try {
      result = await applyPremiumStateEvent(prisma, { eventId, appUserId, type, state });
    } catch (err) {
      if (err instanceof NoMatchingRevenueCatUserError) {
        logApp("ERROR", "RevenueCat", "webhook user not found; requesting retry", {
          type,
          userId: appUserId,
        });
        return res.status(503).json({
          error: "revenuecat_user_not_found",
          retry: true,
        });
      }
      throw err;
    }

    if (result.deduped) {
      return res.json({ ok: true, deduped: true });
    }

    logApp("INFO", "RevenueCat", "webhook applied", {
      type,
      userId: appUserId,
      active: state.active,
      isLifetime: state.isLifetime,
      matched: result.matched,
      reason: result.reason,
    });

    return res.json({ ok: true, applied: result.applied, type, reason: result.reason });
  } catch (err) {
    next(err);
  }
});

module.exports = {
  webhooksRouter,
  applyPremiumStateEvent,
  buildPremiumUpdateData,
  NoMatchingRevenueCatUserError,
};
