import { Link } from 'react-router-dom';

/* ---------- Formatting helpers ---------- */

export const pkr = (n) =>
  'PKR ' + (n === null || n === undefined || n === '' ? '0' : Number(n).toLocaleString('en-PK'));

export const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const fmtDateTime = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};

export const areaStr = (value, unit) =>
  value === null || value === undefined || value === '' ? '—' : `${value} ${unit || ''}`.trim();

/** WhatsApp click-to-chat link; digits only, prefilled text. */
export function waLink(phone, text) {
  const digits = String(phone || '').replace(/\D/g, '');
  const t = encodeURIComponent(text || 'Assalam-o-Alaikum, following up from NexusCRM.');
  return `https://wa.me/${digits}?text=${t}`;
}

/** Safely pull an array out of a few common API envelope shapes. */
export function asArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['items', 'data', 'results', 'rows', 'list', 'commissions', 'notifications', 'plans', 'deals', 'payments', 'transactions', 'schedule', 'followups', 'users', 'leads', 'contacts', 'properties']) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return [];
}

/** Normalize {a: n} or [{stage, count}] shapes into [{key, count}]. */
export function asKeyCounts(data, keyName = 'key') {
  if (Array.isArray(data)) {
    return data.map((r) => ({
      [keyName]: r[keyName] || r.stage || r.status || r.name || '—',
      count: r.count ?? r.total ?? r.value ?? 0,
    }));
  }
  if (data && typeof data === 'object') {
    return Object.entries(data).map(([k, v]) => ({ [keyName]: k, count: Number(v) || 0 }));
  }
  return [];
}

/* ---------- Status badge colors ---------- */

const STATUS_COLORS = {
  available: 'b-green', booked: 'b-amber', sold: 'b-slate', blocked: 'b-red',
  active: 'b-green', pending: 'b-amber', overdue: 'b-red', paid: 'b-green',
  done: 'b-green', complete: 'b-green', completed: 'b-green',
  proposed: 'b-blue', token_paid: 'b-indigo', in_progress: 'b-amber',
  closed_won: 'b-green', closed_lost: 'b-slate', cancelled: 'b-red',
  won: 'b-green', lost: 'b-slate',
  new: 'b-blue', contacted: 'b-indigo', qualified: 'b-amber',
  negotiating: 'b-amber', viewing: 'b-indigo',
  buyer: 'b-blue', seller: 'b-amber',
  unread: 'b-indigo', read: 'b-slate',
};

export function statusColor(status) {
  if (!status) return 'b-slate';
  const key = String(status).toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_COLORS[key] || 'b-slate';
}

export function prettyLabel(s) {
  if (!s) return '—';
  return String(s).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function Badge({ status, color }) {
  return <span className={`badge ${color || statusColor(status)}`}>{prettyLabel(status)}</span>;
}

/* ---------- Presentational components ---------- */

export function Card({ title, actions, children, className }) {
  return (
    <div className={`card ${className || ''}`}>
      {(title || actions) && (
        <div className="flex-between" style={{ marginBottom: 12 }}>
          {title && <h2 className="card-title" style={{ margin: 0 }}>{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function PageHeader({ title, sub, actions }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, sub, accent }) {
  return (
    <div className={`stat ${accent ? 'accent' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }) {
  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'modal-lg' : ''}`}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, hint, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon || '📭'}</div>
      <div style={{ fontWeight: 700, color: 'var(--slate-700)' }}>{title || 'Nothing here yet'}</div>
      {hint && <div className="muted mt-2">{hint}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Spinner() {
  return (
    <div className="spinner-wrap"><div className="spinner" /></div>
  );
}

export function Alert({ kind, children }) {
  return <div className={`alert alert-${kind || 'info'}`}>{children}</div>;
}

export function Field({ label, hint, children }) {
  return (
    <div className="field">
      {label && <label className="label">{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/** WhatsApp icon button; renders nothing when there is no usable phone number. */
export function WaButton({ phone, name, className }) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return (
    <a
      className={className || 'icon-btn wa-icon'}
      href={waLink(phone, `Assalam-o-Alaikum${name ? ' ' + name : ''}, following up from NexusCRM.`)}
      target="_blank"
      rel="noreferrer"
      title={`Chat on WhatsApp${name ? ' with ' + name : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <span role="img" aria-label="WhatsApp">💬</span>
    </a>
  );
}

/** Breadcrumb-ish back link. */
export function BackLink({ to, label }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <Link to={to} style={{ fontSize: 13 }}>← {label || 'Back'}</Link>
    </div>
  );
}
