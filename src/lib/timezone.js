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
 * Parse YYYY-MM-DD into calendar parts, rejecting overflow dates (Feb 31, non-leap Feb 29).
 * @param {unknown} ymd
 * @returns {{ y: number, m: number, d: number } | null}
 */
function parseYmd(ymd) {
  if (typeof ymd !== "string" || !YMD_RE.test(ymd.trim())) return null;
  const [y, m, d] = ymd.trim().split("-").map(Number);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  if (
    probe.getUTCFullYear() !== y ||
    probe.getUTCMonth() !== m - 1 ||
    probe.getUTCDate() !== d
  ) {
    return null;
  }
  return { y, m, d };
}

/**
 * Convert a local wall-clock reading on a real calendar date to a UTC instant.
 * Two-pass offset correction so midnight/DST edges converge.
 * @param {number} y
 * @param {number} m
 * @param {number} d
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @param {number} ms
 * @param {string} timeZone
 * @returns {Date}
 */
function zonedWallClockToUtc(y, m, d, hour, minute, second, ms, timeZone) {
  const tz = normalizeTimeZone(timeZone);
  const asIfUtc = Date.UTC(y, m - 1, d, hour, minute, second, ms);
  const offset1 = offsetMinutesAt(new Date(asIfUtc), tz);
  const first = asIfUtc - offset1 * 60000;
  const offset2 = offsetMinutesAt(new Date(first), tz);
  if (offset1 === offset2) return new Date(first);
  return new Date(asIfUtc - offset2 * 60000);
}

/**
 * Convert a calendar date ("YYYY-MM-DD") to the UTC instant of noon local time
 * in `timeZone` on that date.
 * @param {string} ymd
 * @param {string} timeZone
 * @returns {Date|null} null when `ymd` is malformed or not a real calendar date
 */
function ymdToZonedNoonUtc(ymd, timeZone) {
  const parts = parseYmd(ymd);
  if (!parts) return null;
  return zonedWallClockToUtc(parts.y, parts.m, parts.d, 12, 0, 0, 0, timeZone);
}

/**
 * Inclusive start of the local calendar day (00:00:00.000 in `timeZone`).
 * @param {string} ymd
 * @param {string} timeZone
 * @returns {Date|null}
 */
function startOfZonedDayUtc(ymd, timeZone) {
  const parts = parseYmd(ymd);
  if (!parts) return null;
  return zonedWallClockToUtc(parts.y, parts.m, parts.d, 0, 0, 0, 0, timeZone);
}

/**
 * Inclusive end of the local calendar day (last millisecond before the next local midnight).
 * @param {string} ymd
 * @param {string} timeZone
 * @returns {Date|null}
 */
function endOfZonedDayUtc(ymd, timeZone) {
  const parts = parseYmd(ymd);
  if (!parts) return null;
  const next = new Date(Date.UTC(parts.y, parts.m - 1, parts.d + 1, 12, 0, 0));
  const nextStart = zonedWallClockToUtc(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
    0,
    0,
    0,
    0,
    timeZone
  );
  return new Date(nextStart.getTime() - 1);
}

/**
 * Parse overview/list `from`/`to` query bounds.
 *
 * Date-only `YYYY-MM-DD` is a calendar day in `timeZone` (start of day for `from`,
 * end of day for `to`) so noon-anchored backdated rows are included. Other parseable
 * strings stay absolute instants (`new Date`), matching the previous contract.
 *
 * @param {unknown} raw
 * @param {string} timeZone
 * @param {"from" | "to"} side
 * @returns {{ date: Date | undefined, error: string | null }}
 */
function parseOccurredRangeBound(raw, timeZone, side) {
  if (typeof raw !== "string" || !raw.trim()) {
    return { date: undefined, error: null };
  }
  const s = raw.trim();
  if (YMD_RE.test(s)) {
    const date = side === "from" ? startOfZonedDayUtc(s, timeZone) : endOfZonedDayUtc(s, timeZone);
    if (!date || Number.isNaN(date.getTime())) {
      return { date: undefined, error: `Invalid ${side} date` };
    }
    return { date, error: null };
  }
  const date = new Date(s);
  if (Number.isNaN(date.getTime())) {
    return { date: undefined, error: `Invalid ${side} date` };
  }
  return { date, error: null };
}

module.exports = {
  DEFAULT_TIMEZONE,
  isValidTimeZone,
  normalizeTimeZone,
  ymdToZonedNoonUtc,
  startOfZonedDayUtc,
  endOfZonedDayUtc,
  parseOccurredRangeBound,
};
