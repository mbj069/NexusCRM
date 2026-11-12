import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { get, post, put, del, qs, asArray } from '../api';
import {
  PageHeader, Card, Badge, Modal, EmptyState, Spinner, Alert, Field,
  fmtDate, prettyLabel,
} from '../components/ui';

function FollowupForm({ onSaved, onCancel }) {
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [entityType, setEntityType] = useState('lead');
  const [entityId, setEntityId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!title.trim() || !dueDate) { setError('Title and due date are required.'); return; }
    setBusy(true);
    try {
      const payload = { title: title.trim(), dueDate };
      if (entityType && entityId) { payload.entityType = entityType; payload.entityId = entityId.trim(); }
      await post('/api/followups', payload);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {error && <Alert kind="error">{error}</Alert>}
      <Field label="Title *">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Call Ahmed about token money" required />
      </Field>
      <div className="form-row">
        <Field label="Due date *">
          <input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
        </Field>
        <Field label="Linked record type">
          <select className="select" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="lead">Lead</option>
            <option value="contact">Contact</option>
            <option value="deal">Deal</option>
            <option value="">None</option>
          </select>
        </Field>
      </div>
      {entityType && (
        <Field label="Record ID" hint="Open the lead/contact/deal to find its ID in the URL.">
          <input className="input" type="number" min="1" value={entityId} onChange={(e) => setEntityId(e.target.value)} placeholder="e.g. 12" />
        </Field>
      )}
      <div className="modal-foot">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add follow-up'}</button>
      </div>
    </form>
  );
}

const entityLink = (f) => {
  if (!f.entityType || !f.entityId) return null;
  const map = { lead: 'leads', contact: 'contacts', deal: 'deals' };
  const base = map[f.entityType];
  if (!base) return null;
  return <Link to={`/${base}/${f.entityId}`} className="btn btn-ghost btn-sm">Open →</Link>;
};

export default function Followups() {
  const location = useLocation();
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [showOverdueOnly, setShowOverdueOnly] = useState(false);
  const [showMineOnly, setShowMineOnly] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async (overdue = showOverdueOnly, mine = showMineOnly) => {
    setLoading(true);
    setError('');
    try {
      const params = {};
      if (overdue) params.overdue = 1;
      if (mine) params.mine = 1;
      setItems(asArray(await get('/api/followups' + qs(params))));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(false, false);
    // Quick Add from the dashboard navigates here with { openNew: true }.
    if (location.state?.openNew) {
      setShowNew(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, []);

  const toggleOverdue = () => { const v = !showOverdueOnly; setShowOverdueOnly(v); load(v, showMineOnly); };
  const toggleMine = () => { const v = !showMineOnly; setShowMineOnly(v); load(showOverdueOnly, v); };

  const markDone = async (f) => {
    try {
      await put(`/api/followups/${f.id}`, { done: true });
      setItems((prev) => prev.map((x) => (x.id === f.id ? { ...x, done: true } : x)));
    } catch (e) {
      setError(e.message);
    }
  };

  const remove = async (f) => {
    if (!window.confirm('Delete this follow-up?')) return;
    try {
      await del(`/api/followups/${f.id}`);
      setItems((prev) => prev.filter((x) => x.id !== f.id));
    } catch (e) {
      setError(e.message);
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const isOverdue = (f) => !f.done && (f.dueDate || f.due_date || '') < today;

  const open = items.filter((f) => !f.done);
  const done = items.filter((f) => f.done);

  const Row = ({ f }) => (
    <tr className={isOverdue(f) ? 'overdue-row' : ''}>
      <td>
        <strong>{f.title}</strong>
        {f.entityType && f.entityId && (
          <div className="muted">{prettyLabel(f.entityType)} #{f.entityId}</div>
        )}
      </td>
      <td>{fmtDate(f.dueDate || f.due_date)}</td>
      <td>{isOverdue(f) ? <Badge status="overdue" /> : f.done ? <Badge status="done" /> : <Badge status="pending" />}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {entityLink(f)}
        {!f.done && <button className="btn btn-ghost btn-sm" onClick={() => markDone(f)}>✓ Done</button>}
        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red-600)' }} onClick={() => remove(f)}>Delete</button>
      </td>
    </tr>
  );

  return (
    <>
      <PageHeader
        title="Follow-ups"
        sub="Never let a lead or installment slip through the cracks"
        actions={<button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New follow-up</button>}
      />

      {error && <Alert kind="error">{error}</Alert>}

      <div className="filter-bar">
        <label className="checkbox-row">
          <input type="checkbox" checked={showOverdueOnly} onChange={toggleOverdue} /> Overdue only
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={showMineOnly} onChange={toggleMine} /> Assigned to me
        </label>
        <span className="muted">{open.length} open · {done.length} done</span>
      </div>

      {loading ? <Spinner /> : (
        <>
          <Card title={`Open (${open.length})`}>
            {open.length === 0 ? (
              <EmptyState icon="✅" title="All caught up" hint="No open follow-ups match the filters." />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Title</th><th>Due</th><th>Status</th><th></th></tr></thead>
                  <tbody>{open.map((f) => <Row key={f.id} f={f} />)}</tbody>
                </table>
              </div>
            )}
          </Card>

          {done.length > 0 && (
            <Card title={`Completed (${done.length})`} className="section-gap">
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Title</th><th>Due</th><th>Status</th><th></th></tr></thead>
                  <tbody>{done.map((f) => <Row key={f.id} f={f} />)}</tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      {showNew && (
        <Modal title="New follow-up" onClose={() => setShowNew(false)}>
          <FollowupForm onCancel={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />
        </Modal>
      )}
    </>
  );
}
