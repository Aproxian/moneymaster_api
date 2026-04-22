/**
 * @param {Date} anchorUtc last executed slot (or planned first slot)
 * @param {import('@prisma/client').RecurrenceUnit} unit
 * @param {number} count interval multiplier (>=1)
 * @param {number | null | undefined} hourOfDay 0–23 UTC when unit is DAY or longer
 */
function advanceScheduleUtc(anchorUtc, unit, count, hourOfDay) {
  const c = Math.max(1, count | 0);
  const d = new Date(anchorUtc.getTime());

  switch (unit) {
    case "HOUR":
      d.setUTCHours(d.getUTCHours() + c);
      return d;
    case "DAY": {
      if (hourOfDay != null) {
        const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        const next = new Date(base);
        next.setUTCDate(next.getUTCDate() + c);
        next.setUTCHours(Math.min(23, Math.max(0, hourOfDay)), 0, 0, 0);
        return next;
      }
      const next = new Date(d);
      next.setUTCDate(next.getUTCDate() + c);
      return next;
    }
    case "WEEK": {
      if (hourOfDay != null) {
        const base = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
        const next = new Date(base);
        next.setUTCDate(next.getUTCDate() + 7 * c);
        next.setUTCHours(Math.min(23, Math.max(0, hourOfDay)), 0, 0, 0);
        return next;
      }
      const next = new Date(d);
      next.setUTCDate(next.getUTCDate() + 7 * c);
      return next;
    }
    case "MONTH": {
      const y = d.getUTCFullYear();
      const m = d.getUTCMonth();
      const day = d.getUTCDate();
      const totalM = m + c;
      const ny = y + Math.floor(totalM / 12);
      const nmod = ((totalM % 12) + 12) % 12;
      const lastDom = new Date(Date.UTC(ny, nmod + 1, 0)).getUTCDate();
      const dom = Math.min(day, lastDom);
      const next = new Date(Date.UTC(ny, nmod, dom));
      const hod = hourOfDay != null ? Math.min(23, Math.max(0, hourOfDay)) : d.getUTCHours();
      next.setUTCHours(hod, d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
      return next;
    }
    case "YEAR": {
      const next = new Date(
        Date.UTC(d.getUTCFullYear() + c, d.getUTCMonth(), d.getUTCDate())
      );
      const hod = hourOfDay != null ? Math.min(23, Math.max(0, hourOfDay)) : d.getUTCHours();
      next.setUTCHours(hod, d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
      return next;
    }
    default:
      return d;
  }
}

module.exports = { advanceScheduleUtc };
