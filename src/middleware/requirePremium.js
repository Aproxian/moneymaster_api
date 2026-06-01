"use strict";

const { prisma } = require("../prisma");
const { isAdminUserEmail } = require("../lib/adminUser");
const { REVENUECAT_ENTITLEMENT_ID } = require("../lib/revenuecat");

/**
 * Server-side mirror of the mobile PremiumGate: rejects requests from users without an active
 * `full_access` entitlement (subscription, lifetime, or active trial).
 *
 * SAFETY: enforcement is OFF unless `PREMIUM_ENFORCEMENT_ENABLED` is truthy ("1"/"true"/"yes").
 * This prevents an accidental deploy from locking out every existing (non-premium) user before
 * the store products are live. The mobile app gates on RevenueCat directly regardless; this is
 * defense-in-depth against a modified client.
 *
 * Must run AFTER {@link requireAuth} (reads `req.auth.userId`).
 * @type {import('express').RequestHandler}
 */
function isEnforcementEnabled() {
  const v = process.env.PREMIUM_ENFORCEMENT_ENABLED?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function hasActivePremium(user) {
  if (!user) return false;
  if (user.premiumIsLifetime) return true;
  if (!user.premiumActive) return false;
  if (user.premiumExpiresAt && user.premiumExpiresAt.getTime() <= Date.now()) return false;
  return true;
}

async function requirePremium(req, res, next) {
  try {
    if (!isEnforcementEnabled()) return next();

    const userId = req.auth?.userId;
    if (!userId) {
      // requirePremium is only mounted behind requireAuth; missing auth means misconfiguration.
      return res.status(401).json({ error: "Unauthorized" });
    }

    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        email: true,
        premiumActive: true,
        premiumIsLifetime: true,
        premiumExpiresAt: true,
      },
    });

    // Operator/admin always retains access (parity with the maintenance bypass).
    if (user && isAdminUserEmail(user.email)) return next();

    if (!hasActivePremium(user)) {
      return res.status(402).json({
        code: "PREMIUM_REQUIRED",
        entitlement: REVENUECAT_ENTITLEMENT_ID,
        error: "An active subscription or lifetime purchase is required to use MoneyMASTER.",
        message: "An active subscription or lifetime purchase is required to use MoneyMASTER.",
      });
    }

    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requirePremium, isPremiumEnforcementEnabled: isEnforcementEnabled };
