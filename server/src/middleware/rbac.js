// Role-based access control. The server is the gate — any frontend
// permission checks are UX only.
//
// Access matrix (enforced server-side on every route; the frontend nav
// only mirrors it):
// admin   = everything — dashboard totals, users, audit log, settings
//           (AI/WhatsApp), manual commissions, all leads/deals/payments,
//           lead assignment.
// manager = team-view dashboard (no money totals), all leads/deals/
//           payments, lead assignment, inventory, contacts, follow-ups,
//           commissions view-only. No users, no audit log, no settings.
// agent   = own dashboard only, assigned leads only, own deals only, own
//           commissions only, inventory browse (no totals), contacts
//           linked to their own leads/deals, own follow-ups. No users, no
//           audit log, no settings, no unassigned leads, no other agents'
//           data.

export const ROLES = {
  admin: ['manage_users', 'ai_config', 'whatsapp_config', 'view_audit_log', 'pay_commissions', 'assign_commissions', 'assign_leads', 'crm'],
  manager: ['assign_leads', 'crm'],
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
