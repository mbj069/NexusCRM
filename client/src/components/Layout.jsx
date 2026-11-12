import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { get, post, asArray } from '../api';
import { fmtDateTime } from './ui';

const NAV = [
  { to: '/', label: 'Dashboard', icon: '📊', roles: ['admin', 'manager', 'agent'], end: true },
  { to: '/leads', label: 'Leads', icon: '🎯', roles: ['admin', 'manager', 'agent'] },
  { to: '/contacts', label: 'Contacts', icon: '👥', roles: ['admin', 'manager', 'agent'] },
  { to: '/inventory', label: 'Inventory', icon: '🏘️', roles: ['admin', 'manager', 'agent'] },
  { to: '/deals', label: 'Deals', icon: '🤝', roles: ['admin', 'manager', 'agent'] },
  { to: '/payments', label: 'Payments', icon: '💳', roles: ['admin', 'manager'] },
  { to: '/commissions', label: 'Commissions', icon: '💰', roles: ['admin', 'manager', 'agent'] },
  { to: '/expenses', label: 'Expenses', icon: '🧾', roles: ['admin', 'manager'] },
  { to: '/followups', label: 'Follow-ups', icon: '⏰', roles: ['admin', 'manager', 'agent'] },
  { to: '/settings', label: 'Settings', icon: '⚙️', roles: ['admin'] },
];

function NotificationsBell() {
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const load = async () => {
    try {
      const data = await get('/api/notifications');
      setItems(asArray(data));
    } catch {
      setItems([]);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Backend shape: { notifications: [{ id, title, body, isRead: 0|1, createdAt }], unreadCount }
  const isUnread = (n) => !(n.isRead || n.read);
  const unreadCount = items.filter(isUnread).length;

  const markRead = async (n) => {
    if (!isUnread(n)) return;
    try {
      await post(`/api/notifications/${n.id}/read`);
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true, isRead: 1 } : x)));
    } catch {
      /* non-fatal */
    }
  };

  return (
    <div className="bell-wrap" ref={ref}>
      <button className="bell-btn" onClick={() => setOpen((o) => !o)} aria-label="Notifications">
        🔔
        {unreadCount > 0 && <span className="bell-count">{unreadCount}</span>}
      </button>
      {open && (
        <div className="bell-dropdown">
          <div className="bell-head">Notifications</div>
          {items.length === 0 && <div className="empty" style={{ padding: 20 }}>No notifications</div>}
          {items.slice(0, 30).map((n) => (
            <div
              key={n.id}
              className={`bell-item ${isUnread(n) ? 'unread' : ''}`}
              onClick={() => markRead(n)}
            >
              <div>
                <div><strong>{n.title || 'Notification'}</strong></div>
                {n.body && <div className="muted">{n.body}</div>}
              </div>
              {(n.createdAt || n.created_at) && (
                <div className="bell-time">{fmtDateTime(n.createdAt || n.created_at)}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const role = user?.role || 'agent';
  const links = NAV.filter((l) => l.roles.includes(role));

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const initial = (user?.name || user?.username || '?').charAt(0).toUpperCase();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">N</div>
          <div>
            <div className="brand-name">NexusCRM</div>
            <div className="brand-sub">Property Dealer CRM</div>
          </div>
        </div>
        <nav className="nav">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              <span className="nav-icon">{l.icon}</span>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">NexusCRM v1.3</div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar-title">NexusCRM</div>
          <div className="topbar-right">
            <NotificationsBell />
            <div className="user-chip">
              <div className="user-avatar">{initial}</div>
              <div className="user-meta">
                <div className="user-name">{user?.name || user?.username}</div>
                <div className="user-role">{role}</div>
              </div>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={handleLogout}>Logout</button>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
