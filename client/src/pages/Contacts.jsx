import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { get, post, put, del, qs, asArray } from '../api';
import {
  PageHeader, Card, Badge, Modal, EmptyState, Spinner, Alert, Field,
  fmtDateTime, prettyLabel, WaButton, BackLink,
} from '../components/ui';

const KIND_ICONS = { note: '📝', call: '📞', viewing: '👁️', message: '💬', stage_change: '🔀' };

function ContactForm({ initial, onSaved, onCancel }) {
  const [f, setF] = useState({
    name: '', phone: '', whatsapp: '', type: 'buyer', source: '', email: '', notes: '',
    ...(initial || {}),
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!f.name.trim()) { setError('Name is required.'); return; }
    setSaving(true);
    try {
      const payload = { ...f };
      Object.keys(payload).forEach((k) => { if (payload[k] === '') delete payload[k]; });
      if (initial?.id) await put(`/api/contacts/${initial.id}`, payload);
      else await post('/api/contacts', payload);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="form-row">
        <Field label="Full name *"><input className="input" value={f.name} onChange={set('name')} required /></Field>
        <Field label="Type">
          <select className="select" value={f.type} onChange={set('type')}>
            <option value="buyer">Buyer</option>
            <option value="seller">Seller</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} /></Field>
        <Field label="WhatsApp"><input className="input" value={f.whatsapp} onChange={set('whatsapp')} /></Field>
      </div>
      <div className="form-row">
        <Field label="Email"><input className="input" type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Source"><input className="input" value={f.source} onChange={set('source')} /></Field>
      </div>
      <Field label="Notes"><textarea className="textarea" value={f.notes} onChange={set('notes')} /></Field>
      <div className="modal-foot">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : (initial?.id ? 'Save changes' : 'Add contact')}</button>
      </div>
    </form>
  );
}

export function Contacts() {
  const navigate = useNavigate();
  const location = useLocation();
  const [contacts, setContacts] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);

  const load = async (query = q) => {
    setLoading(true);
    setError('');
    try {
      setContacts(asArray(await get('/api/contacts' + qs({ q: query }))));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load('');
    // Quick Add from the dashboard navigates here with { openNew: true }.
    if (location.state?.openNew) {
      setShowNew(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, []);

  const remove = async (c) => {
    if (!window.confirm(`Delete contact "${c.name}"? This cannot be undone.`)) return;
    try {
      await del(`/api/contacts/${c.id}`);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <>
      <PageHeader
        title="Contacts"
        sub="Your address book of buyers and sellers"
        actions={<button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New contact</button>}
      />

      <div className="filter-bar">
        <Field label="Search">
          <input className="input" style={{ minWidth: 240 }} placeholder="Name or phone…" value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(q); }} />
        </Field>
        <button className="btn btn-secondary" onClick={() => load(q)}>Search</button>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      {loading ? <Spinner /> : contacts.length === 0 ? (
        <Card><EmptyState icon="👥" title="No contacts found" hint="Add your first contact to get started." /></Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Phone</th><th>Type</th><th>Source</th><th></th><th></th></tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} className="row-link" onClick={() => navigate(`/contacts/${c.id}`)}>
                  <td><strong>{c.name}</strong></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {c.phone || '—'}
                      <WaButton phone={c.whatsapp || c.phone} name={c.name} />
                    </span>
                  </td>
                  <td><Badge status={c.type} /></td>
                  <td className="muted">{c.source || '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Link to={`/payments/ledgers/${c.id}`} className="btn btn-ghost btn-sm">Ledger →</Link>
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red-600)' }} onClick={() => remove(c)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <Modal title="New contact" onClose={() => setShowNew(false)} wide>
          <ContactForm onCancel={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(''); }} />
        </Modal>
      )}
    </>
  );
}

/* ================= Contact detail ================= */

function DocumentsPanel({ entityType, entityId }) {
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setDocs(asArray(await get('/api/documents' + qs({ entityType, entityId }))));
    } catch (e) {
      setError(e.message);
    }
  };

  useEffect(() => { load(); }, [entityType, entityId]);

  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('entityType', entityType);
      fd.append('entityId', String(entityId));
      await post('/api/documents', fd);
      e.target.value = '';
      load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (d) => {
    if (!window.confirm(`Delete "${d.filename || d.name || 'document'}"?`)) return;
    try {
      await del(`/api/documents/${d.id}`);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex-between" style={{ marginBottom: 10 }}>
        <span className="muted">CNIC copies, bayana receipts, agreements…</span>
        <label className="btn btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
          {busy ? 'Uploading…' : '📎 Upload document'}
          <input type="file" hidden onChange={upload} disabled={busy} />
        </label>
      </div>
      {docs.length === 0 ? (
        <EmptyState icon="📎" title="No documents" hint="Upload the first document for this record." />
      ) : (
        <div className="timeline">
          {docs.map((d) => (
            <div key={d.id} className="tl-item">
              <div className="tl-dot">📄</div>
              <div className="tl-body flex-between" style={{ width: '100%' }}>
                <div>
                  <div>{d.filename || d.originalName || d.name || `Document #${d.id}`}</div>
                  <div className="tl-meta">{fmtDateTime(d.createdAt || d.created_at)}{d.size ? ` · ${d.size}` : ''}</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <a className="btn btn-ghost btn-sm" href={`/api/documents/${d.id}/download`}>Download</a>
                  <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red-600)' }} onClick={() => remove(d)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ContactDetail() {
  const { id } = useParams();
  const [contact, setContact] = useState(null);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [actKind, setActKind] = useState('note');
  const [actText, setActText] = useState('');
  const [actBusy, setActBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [c, a] = await Promise.all([
        get(`/api/contacts/${id}`),
        get(`/api/activities/contact/${id}`).catch(() => []),
      ]);
      setContact(c.contact || c);
      setActivities(asArray(a));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const addActivity = async (e) => {
    e.preventDefault();
    if (!actText.trim()) return;
    setActBusy(true);
    try {
      await post('/api/activities', { entityType: 'contact', entityId: id, kind: actKind, text: actText.trim() });
      setActText('');
      setActivities(asArray(await get(`/api/activities/contact/${id}`).catch(() => [])));
    } catch (err) {
      setNotice(err.message);
    } finally {
      setActBusy(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return (<><BackLink to="/contacts" label="Contacts" /><Alert kind="error">{error}</Alert></>);
  if (!contact) return (<><BackLink to="/contacts" label="Contacts" /><Alert kind="error">Contact not found.</Alert></>);

  return (
    <>
      <BackLink to="/contacts" label="Contacts" />
      <PageHeader
        title={contact.name}
        sub={`${prettyLabel(contact.type || 'buyer')} · ${contact.phone || 'no phone'}`}
        actions={
          <>
            <Link to={`/payments/ledgers/${contact.id}`} className="btn btn-secondary">📒 View ledger</Link>
            <button className="btn btn-secondary" onClick={() => setShowEdit(true)}>Edit</button>
          </>
        }
      />

      {notice && <Alert kind="error">{notice}</Alert>}

      <Card title="Contact information">
        <dl className="kv">
          <dt>Phone</dt><dd>{contact.phone || '—'}</dd>
          <dt>WhatsApp</dt>
          <dd>
            {contact.whatsapp || contact.phone ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {contact.whatsapp || contact.phone}
                <WaButton phone={contact.whatsapp || contact.phone} name={contact.name} />
              </span>
            ) : '—'}
          </dd>
          <dt>Email</dt><dd>{contact.email || '—'}</dd>
          <dt>Source</dt><dd>{contact.source || '—'}</dd>
          <dt>Notes</dt><dd>{contact.notes || '—'}</dd>
        </dl>
      </Card>

      <Card title="Documents" className="section-gap">
        <DocumentsPanel entityType="contact" entityId={contact.id} />
      </Card>

      <Card title="Activity" className="section-gap">
        <form onSubmit={addActivity} style={{ marginBottom: 14 }}>
          <div className="form-row">
            <Field label="Kind">
              <select className="select" value={actKind} onChange={(e) => setActKind(e.target.value)}>
                {['note', 'call', 'viewing', 'message'].map((k) => <option key={k} value={k}>{prettyLabel(k)}</option>)}
              </select>
            </Field>
            <div />
          </div>
          <Field label="Add activity">
            <textarea className="textarea" value={actText} onChange={(e) => setActText(e.target.value)} placeholder="Log a note or call…" />
          </Field>
          <button className="btn btn-primary btn-sm" disabled={actBusy || !actText.trim()}>{actBusy ? 'Adding…' : 'Add'}</button>
        </form>
        <hr className="divider" />
        {activities.length === 0 ? (
          <EmptyState icon="📝" title="No activity yet" />
        ) : (
          <div className="timeline">
            {activities.map((a, i) => (
              <div key={a.id || i} className="tl-item">
                <div className="tl-dot">{KIND_ICONS[a.kind] || '📝'}</div>
                <div className="tl-body">
                  <div><Badge status={a.kind} /> <span style={{ marginLeft: 6 }}>{a.text}</span></div>
                  <div className="tl-meta">{a.actorName || ''} {fmtDateTime(a.createdAt || a.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {showEdit && (
        <Modal title="Edit contact" onClose={() => setShowEdit(false)} wide>
          <ContactForm initial={contact} onCancel={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); load(); }} />
        </Modal>
      )}
    </>
  );
}

// Re-export so Deals can attach documents to a deal without duplicating code.
export { DocumentsPanel };
