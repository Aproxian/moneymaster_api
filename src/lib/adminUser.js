/**
 * ADMIN_EMAIL from env identifies the single operator allowed for dev/admin routes.
 * Comparison is case-insensitive; whitespace trimmed.
 */
function isAdminUserEmail(email) {
  const configured = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  if (!configured) return false;
  return (email ?? "").trim().toLowerCase() === configured;
}

module.exports = { isAdminUserEmail };
