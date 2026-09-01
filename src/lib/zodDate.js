"use strict";

const { z } = require("zod");

/**
 * Optional date input that treats JSON null as an omitted value.
 *
 * Zod 4's `z.coerce.date()` converts null via `new Date(null)` to the Unix
 * epoch, which is never the intended meaning for optional API date fields.
 */
const optionalCoercedDate = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.date().optional()
);

/**
 * Required date input that rejects JSON null (instead of coercing to epoch).
 *
 * Used for schedule timing fields where epoch would make the row immediately
 * due and can burst materialize up to MAX_BURST ledger posts.
 */
const requiredCoercedDate = z.preprocess((value) => {
  if (value == null) return undefined;
  return value;
}, z.coerce.date());

module.exports = { optionalCoercedDate, requiredCoercedDate };
