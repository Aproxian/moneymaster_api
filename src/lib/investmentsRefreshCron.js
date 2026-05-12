"use strict";

const crypto = require("crypto");

/** Header clients send (Express normalizes to lowercase). */
const CRON_SECRET_HEADER = "x-moneymaster-investments-cron";

/** Calendar day for "once per day" sweep gate (Bulgaria / Sofia). */
const SWEEP_DAY_TIMEZONE = process.env.INVESTMENTS_SWEEP_DAY_TIMEZONE?.trim() || "Europe/Sofia";

/**
 * @returns {string} YYYY-MM-DD in SWEEP_DAY_TIMEZONE for `date` (default now).
 */
function calendarDateInSweepTimezone(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SWEEP_DAY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  if (!y || !m || !d) {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: SWEEP_DAY_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  }
  return `${y}-${m}-${d}`;
}

/**
 * Constant-time string compare (UTF-8). Returns false if lengths differ.
 * @param {string} a
 * @param {string} b
 */
function timingSafeEqualUtf8(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function normalizeClientIp(ip) {
  const s = String(ip || "").trim();
  if (s.startsWith("::ffff:")) return s.slice(7);
  return s;
}

/**
 * @returns {string[]} trimmed non-empty entries from INVESTMENTS_CRON_ALLOWED_IPS (comma-separated).
 */
function parseAllowedCronIps() {
  const raw = process.env.INVESTMENTS_CRON_ALLOWED_IPS?.trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * IPv4 dotted quad to 32-bit unsigned int.
 * @param {string} ip
 * @returns {number | null}
 */
function ipv4ToInt(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if (parts.some((n) => n > 255 || n < 0)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * @param {string} clientIp normalized IPv4
 * @param {string} rule single IP or "a.b.c.d/nn"
 * @returns {boolean}
 */
function ipv4MatchesRule(clientIp, rule) {
  const r = rule.trim();
  const slash = r.lastIndexOf("/");
  if (slash === -1) {
    return clientIp === r;
  }
  const base = r.slice(0, slash).trim();
  const bitsStr = r.slice(slash + 1);
  const bits = Number.parseInt(bitsStr, 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const client = ipv4ToInt(clientIp);
  const network = ipv4ToInt(base.trim());
  if (client == null || network == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (client & mask) === (network & mask);
}

/**
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function isCronClientIpAllowed(req) {
  const allow = parseAllowedCronIps();
  if (allow.length === 0) return true;

  const raw = (req.ip && String(req.ip).trim()) || req.socket?.remoteAddress || "";
  const client = normalizeClientIp(raw);
  if (!client) return false;

  for (const rule of allow) {
    if (client.includes(":")) {
      if (client === rule.trim()) return true;
      continue;
    }
    if (ipv4MatchesRule(client, rule)) return true;
  }
  return false;
}

module.exports = {
  CRON_SECRET_HEADER,
  SWEEP_DAY_TIMEZONE,
  calendarDateInSweepTimezone,
  isCronClientIpAllowed,
  parseAllowedCronIps,
  timingSafeEqualUtf8,
};
