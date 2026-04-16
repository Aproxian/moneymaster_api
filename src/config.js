module.exports.config = {
  port: Number(process.env.PORT ?? 3000),
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET ?? "dev_access_secret_change_me",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET ?? "dev_refresh_secret_change_me",
  accessTtlSeconds: 15 * 60, // 15 min
  /** Refresh session length; set REFRESH_TTL_DAYS in .env (e.g. 90). Capped 1–365. */
  refreshTtlDays: Math.min(
    365,
    Math.max(1, Number(process.env.REFRESH_TTL_DAYS ?? 90) || 90)
  ),
};
