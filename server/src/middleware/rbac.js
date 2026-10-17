// Role-based access control. The server is the gate — any frontend
// permission checks are UX only.
//
// admin   = everything (manage_users, ai_config, whatsapp_config,
//           view_audit_log, pay_commissions, crm)
// manager = all CRM/inventory/deals/payments/documents/notifications CRUD,
//           view_audit_log, pay_commissions; no manage_users/ai_config/whatsapp_config
// agent   = same CRM CRUD as manager; commissions list is filtered to the
//           agent's own rows, no view_audit_log, no pay_commissions

export const ROLES = {
  admin: ['manage_users', 'ai_config', 'whatsapp_config', 'view_audit_log', 'pay_commissions', 'crm'],
  manager: ['view_audit_log', 'pay_commissions', 'crm'],
  agent: ['crm'],
};

export function can(role, permission) {
  return (ROLES[role] || []).includes(permission);
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Missing credentials.' });
    if (!can(req.user.role, permission)) {
      return res.status(403).json({ error: 'Insufficient permissions.' });
    }
    next();
  };
}
