const { z } = require("zod");

/**
 * Optional date input that treats JSON null as an omitted value.
 *
 * `z.coerce.date()` converts null to the Unix epoch, which is never the
 * intended meaning for optional API date fields.
 */
const optionalCoercedDate = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.date().optional()
);

/**
 * Required date input that rejects JSON null instead of coercing it to epoch.
 */
const requiredCoercedDate = z.preprocess(
  (value) => (value == null ? undefined : value),
  z.coerce.date()
);

module.exports = { optionalCoercedDate, requiredCoercedDate };
