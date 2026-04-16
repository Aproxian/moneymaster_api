/**
 * Use after `requireAccountMember`. Allows only listed roles (e.g. OWNER, ADMIN).
 */
function requireAccountRole(...allowedRoles) {
  return (req, res, next) => {
    const role = req.memberRole;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({ error: "Insufficient permissions for this account" });
    }
    next();
  };
}

module.exports = { requireAccountRole };
