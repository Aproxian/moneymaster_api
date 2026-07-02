/**
 * Timezone helpers (server-side).
 *
 * The mobile client sends transaction dates as a plain calendar date ("YYYY-MM-DD");
 * the server anchors them to *noon* in the account's IANA timezone and stores the
 * resulting UTC instant in `Transaction.occurredAt`. Noon (12:00) is used because it
 * is 12h away from midnight, so the calendar date never drifts across a day boundary
 * when converted to/from UTC regardless of the zone's offset.
 *
 * Node 20+ ships full ICU, so `Intl` timezone math is reliable here.
 */

const DEFAULT_TIMEZONE = "UTC";
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * True if `tz` is a valid IANA timezone identifier this runtime understands.
 * @param {unknown} tz
 * @returns {boolean}
 */
function isValidTimeZone(tz) {
  if (typeof tz !== "string" || !tz.trim()) return false;
  try {
    // Throws RangeError for unknown zones.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize/validate an incoming timezone, falling back to UTC when invalid.
 * @param {unknown} tz
 * @returns {string}
 */
function normalizeTimeZone(tz) {
  return isValidTimeZone(tz) ? String(tz).trim() : DEFAULT_TIMEZONE;
}

/**
 * Offset (in minutes) of `timeZone` from UTC at the given UTC instant.
 * Positive means ahead of UTC (e.g. +120 for Europe/Athens in winter).
 * @param {Date} utcDate
 * @param {string} timeZone
 * @returns {number}
 */
function offsetMinutesAt(utcDate, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(utcDate);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // Interpret the wall-clock reading in `timeZone` as if it were UTC, then diff.
  const asUTC = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second)
  );
  return Math.round((asUTC - utcDate.getTime()) / 60000);
}

/**
 * Convert a calendar date ("YYYY-MM-DD") to the UTC instant of noon local time
 * in `timeZone` on that date.
 * @param {string} ymd
 * @param {string} timeZone
 * @returns {Date|null} null when `ymd` is malformed
 */
function ymdToZonedNoonUtc(ymd, timeZone) {
  if (typeof ymd !== "string" || !YMD_RE.test(ymd.trim())) return null;
  const [y, m, d] = ymd.trim().split("-").map(Number);
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const tz = normalizeTimeZone(timeZone);
  // First guess: treat noon wall-clock as if UTC, then correct by the zone offset
  // measured at that guessed instant (DST-safe for anything but the rare noon-DST edge).
  const guess = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const offset = offsetMinutesAt(guess, tz);
  return new Date(guess.getTime() - offset * 60000);
}

module.exports = {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  normalizeTimeZone,
  ymdToZonedNoonUtc,
};
