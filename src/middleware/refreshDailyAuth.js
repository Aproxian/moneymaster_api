"use strict";

const jwt = require("jsonwebtoken");
const { config } = require("../config");
const { prisma } = require("../prisma");
const {
  CRON_SECRET_HEADER,
  timingSafeEqualUtf8,
  isCronClientIpAllowed,
} = require("../lib/investmentsRefreshCron");

/**
 * Auth for POST /investments/refresh-daily only: either valid cron header + secret (+ optional IP allowlist)
 * or normal Bearer JWT (same rules as requireAuth).
 * Sets req.auth = { userId } (userId null for cron) and req.refreshDailyCron = true when cron.
 * @type {import('express').RequestHandler}
 */
async function refreshDailyAuth(req, res, next) {
  try {
    const cronSecret = process.env.INVESTMENTS_CRON_SECRET?.trim();
    const headerVal = req.get(CRON_SECRET_HEADER)?.trim();

    if (cronSecret && headerVal) {
      if (!timingSafeEqualUtf8(headerVal, cronSecret)) {
        return res.status(403).json({ error: "invalid_cron_secret" });
      }
      if (!isCronClientIpAllowed(req)) {
        return res.status(403).json({ error: "cron_ip_not_allowed" });
      }
      req.refreshDailyCron = true;
      req.auth = { userId: null };
      return next();
    }

    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token) {
      return res.status(401).json({ error: "Missing access token" });
    }

    let payload;
    try {
      payload = jwt.verify(token, config.jwtAccessSecret);
    } catch {
      return res.status(401).json({ error: "Invalid or expired access token" });
    }

    const user = await prisma.user.findFirst({
      where: { id: payload.userId, deletedAt: null },
      select: { id: true },
    });
    if (!user) {
      return res.status(401).json({ error: "Account has been deleted or is unavailable" });
    }

    req.refreshDailyCron = false;
    req.auth = payload;
    return next();
  } catch (e) {
    return next(e);
  }
}

module.exports = { refreshDailyAuth };
