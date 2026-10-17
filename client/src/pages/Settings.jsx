import { useEffect, useState } from 'react';
import { get, post, put, del, qs, asArray } from '../api';
import { useAuth } from '../auth';
import {
  PageHeader, Card, Badge, Modal, EmptyState, Spinner, Alert, Field,
  fmtDateTime,
} from '../components/ui';

/* ================= AI configuration ================= */

function AiTab() {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({ baseUrl: '', apiKey: '', model: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const c = await get('/api/ai/config');
      const cfg = c.config || c || {};
      setConfig(cfg);
      setForm({ baseUrl: cfg.baseUrl || '', apiKey: '', model: cfg.model || '' });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(''); setMsg('');
    try {
      const payload = { baseUrl: form.baseUrl, model: form.model };
      if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim();
      await put('/api/ai/config', payload);
      setForm((s) => ({ ...s, apiKey: '' }));
      setMsg('AI configuration saved.');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError(''); setMsg('');
    try {
      const res = await post('/api/ai/test');
      setMsg('AI connection works. ' + (res?.message || res?.model ? `Model: ${res.model}` : ''));
    } catch (err) {
      if (err.status === 503 || err.code === 'NO_API_KEY') {
        setError('No AI key configured yet — enter a key above and save, then test again.');
      } else {
        setError('AI test failed: ' + err.message);
      }
    } finally {
      setTesting(false);
    }
  };

  if (loading) return <Spinner />;

  const hasKey = config?.hasApiKey || config?.configured || !!config?.apiKeySet;

  return (
    <Card
      title="AI configuration"
      actions={<Badge status={hasKey ? 'configured' : 'not configured'} color={hasKey ? 'b-green' : 'b-amber'} />}
    >
      {error && <Alert kind="error">{error}</Alert>}
      {msg && <Alert kind="ok">{msg}</Alert>}
      <p className="muted" style={{ marginTop: 0 }}>
        Powers AI lead scoring and summaries. The key is stored server-side only —
        it is never shown here after saving.
      </p>
      <form onSubmit={save}>
        <Field label="Base URL" hint="OpenAI-compatible endpoint, e.g. https://api.openai.com/v1">
          <input className="input mono" value={form.baseUrl} onChange={set('baseUrl')} placeholder="https://api.openai.com/v1" />
        </Field>
        <Field label="API key" hint={hasKey ? 'A key is already saved. Enter a new one only to replace it.' : 'Required for AI features.'}>
          <input className="input mono" type="password" value={form.apiKey} onChange={set('apiKey')}
            placeholder={hasKey ? '•••••••• (saved)' : 'sk-…'} autoComplete="new-password" />
        </Field>
        <Field label="Model">
          <input className="input mono" value={form.model} onChange={set('model')} placeholder="e.g. gpt-4o-mini" />
        </Field>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn btn-secondary" onClick={test} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      </form>
    </Card>
  );
}

/* ================= WhatsApp configuration ================= */

function WhatsappTab() {
  const [form, setForm] = useState({ phoneNumberId: '', token: '', verifyToken: '', enabled: false });
  const [hasToken, setHasToken] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testText, setTestText] = useState('Assalam-o-Alaikum! This is a test message from NexusCRM.');
  const [testBusy, setTestBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const c = await get('/api/whatsapp/config');
      const cfg = c.config || c || {};
      setForm({
        phoneNumberId: cfg.phoneNumberId || '',
        token: '',
        verifyToken: cfg.verifyToken || '',
        enabled: !!cfg.enabled,
      });
      setHasToken(!!(cfg.hasToken || cfg.tokenSet));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(''); setMsg('');
    try {
      const payload = {
        phoneNumberId: form.phoneNumberId,
        verifyToken: form.verifyToken,
        enabled: form.enabled,
      };
      if (form.token.trim()) payload.token = form.token.trim();
      await put('/api/whatsapp/config', payload);
      setForm((s) => ({ ...s, token: '' }));
      setMsg('WhatsApp configuration saved.');
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async (e) => {
    e.preventDefault();
    setTestBusy(true);
    setError(''); setMsg('');
    try {
      await post('/api/whatsapp/send-test', { to: testTo.trim(), text: testText });
      setMsg(`Test message sent to ${testTo.trim()}.`);
    } catch (err) {
      setError('Test failed: ' + err.message);
    } finally {
      setTestBusy(false);
    }
  };

  if (loading) return <Spinner />;

  return (
    <>
      <Card
        title="WhatsApp configuration"
        actions={<Badge status={form.enabled ? 'enabled' : 'disabled'} color={form.enabled ? 'b-green' : 'b-slate'} />}
      >
        {error && <Alert kind="error">{error}</Alert>}
        {msg && <Alert kind="ok">{msg}</Alert>}
        <Alert kind="info">
          24/7 automation needs the client's WhatsApp Business Cloud API approval from Meta —
          these credentials only take effect once Meta approves the business number.
        </Alert>
        <form onSubmit={save}>
          <Field label="Phone number ID">
            <input className="input mono" value={form.phoneNumberId} onChange={set('phoneNumberId')} placeholder="From Meta developer dashboard" />
          </Field>
          <Field label="Access token" hint={hasToken ? 'A token is already saved. Enter a new one only to replace it.' : ''}>
            <input className="input mono" type="password" value={form.token} onChange={set('token')}
              placeholder={hasToken ? '•••••••• (saved)' : 'Paste token'} autoComplete="new-password" />
          </Field>
          <Field label="Verify token" hint="Must match the verify token set in the Meta app webhook settings.">
            <input className="input mono" value={form.verifyToken} onChange={set('verifyToken')} />
          </Field>
          <label className="checkbox-row" style={{ marginBottom: 14 }}>
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((s) => ({ ...s, enabled: e.target.checked }))} />
            Enable WhatsApp integration
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </form>
      </Card>

      <Card title="Send a test message" className="section-gap">
        <form onSubmit={sendTest}>
          <div className="form-row">
            <Field label="To (phone)">
              <input className="input" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="e.g. 923001234567" required />
            </Field>
            <div />
          </div>
          <Field label="Message">
            <textarea className="textarea" value={testText} onChange={(e) => setTestText(e.target.value)} />
          </Field>
          <button type="submit" className="btn btn-secondary" disabled={testBusy || !testTo.trim()}>
            {testBusy ? 'Sending…' : 'Send test'}
          </button>
        </form>
      </Card>
    </>
  );
}

/* ================= Users (admin) ================= */

function UsersTab() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setUsers(asArray(await get('/api/users')));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (u) => {
    if (!window.confirm(`Delete user "${u.username}"?`)) return;
    try {
      await del(`/api/users/${u.id}`);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <Card
      title="Users"
      actions={<button className="btn btn-primary btn-sm" onClick={() => setShowNew(true)}>+ New user</button>}
    >
      {error && <Alert kind="error">{error}</Alert>}
      {loading ? <Spinner /> : users.length === 0 ? (
        <EmptyState icon="👤" title="No users" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Name</th><th>Username</th><th>Role</th><th></th><th></th></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td><strong>{u.name || '—'}</strong></td>
                  <td className="mono">{u.username}</td>
                  <td><Badge status={u.role} /></td>
                  <td><button className="btn btn-ghost btn-sm" onClick={() => setEditing(u)}>Edit</button></td>
                  <td><button className="btn btn-ghost btn-sm" style={{ color: 'var(--red-600)' }} onClick={() => remove(u)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(showNew || editing) && (
        <UserModal
          initial={editing}
          onClose={() => { setShowNew(false); setEditing(null); }}
          onSaved={() => { setShowNew(false); setEditing(null); load(); }}
        />
      )}
    </Card>
  );
}

function UserModal({ initial, onClose, onSaved }) {
  const [f, setF] = useState({
    username: initial?.username || '',
    name: initial?.name || '',
    role: initial?.role || 'agent',
    password: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!f.username.trim()) { setError('Username is required.'); return; }
    if (!initial && !f.password) { setError('Password is required for a new user.'); return; }
    setBusy(true);
    try {
      if (initial) {
        const payload = { name: f.name, role: f.role };
        if (f.password) payload.password = f.password;
        await put(`/api/users/${initial.id}`, payload);
      } else {
        await post('/api/users', { username: f.username.trim(), password: f.password, name: f.name, role: f.role });
      }
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit user' : 'New user'} onClose={onClose}>
      <form onSubmit={submit}>
        {error && <Alert kind="error">{error}</Alert>}
        <Field label="Username *">
          <input className="input mono" value={f.username} onChange={set('username')} disabled={!!initial} required={!initial} />
        </Field>
        <Field label="Full name"><input className="input" value={f.name} onChange={set('name')} /></Field>
        <Field label="Role">
          <select className="select" value={f.role} onChange={set('role')}>
            <option value="agent">Agent</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <Field label={initial ? 'New password (leave empty to keep)' : 'Password *'}>
          <input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required={!initial} />
        </Field>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ================= Audit log (admin/manager) ================= */

function AuditTab() {
  const [rows, setRows] = useState([]);
  const [limit, setLimit] = useState(100);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async (l = limit) => {
    setLoading(true);
    setError('');
    try {
      setRows(asArray(await get('/api/audit' + qs({ limit: l }))));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(100); }, []);

  return (
    <Card
      title="Audit log"
      actions={
        <select className="select" style={{ width: 'auto' }} value={limit} onChange={(e) => { setLimit(Number(e.target.value)); load(Number(e.target.value)); }}>
          <option value={50}>Last 50</option>
          <option value={100}>Last 100</option>
          <option value={500}>Last 500</option>
        </select>
      }
    >
      {error && <Alert kind="error">{error}</Alert>}
      {loading ? <Spinner /> : rows.length === 0 ? (
        <EmptyState icon="📜" title="No audit entries" />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id || i}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.timestamp || r.createdAt || r.created_at)}</td>
                  <td>{r.actorName || r.userName || r.username || r.actor || '—'}</td>
                  <td><Badge status={r.action || r.event || r.type} /></td>
                  <td className="muted">{r.details || r.description || r.message || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/* ================= Settings page ================= */

export default function Settings() {
  const { isAdmin, isManager } = useAuth();
  const [tab, setTab] = useState(isAdmin ? 'ai' : 'audit');

  const tabs = [
    isAdmin && { id: 'ai', label: '🤖 AI' },
    isAdmin && { id: 'whatsapp', label: '💬 WhatsApp' },
    isAdmin && { id: 'users', label: '👥 Users' },
    isManager && { id: 'audit', label: '📜 Audit log' },
  ].filter(Boolean);

  return (
    <>
      <PageHeader title="Settings" sub="Integrations, users and the audit trail" />
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'ai' && isAdmin && <AiTab />}
      {tab === 'whatsapp' && isAdmin && <WhatsappTab />}
      {tab === 'users' && isAdmin && <UsersTab />}
      {tab === 'audit' && isManager && <AuditTab />}
    </>
  );
}
