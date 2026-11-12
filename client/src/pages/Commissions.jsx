import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put, qs, asArray } from '../api';
import { useAuth } from '../auth';
import {
  PageHeader, Card, Badge, EmptyState, Spinner, Alert, Field, Modal,
  pkr, fmtDate, fmtDateTime,
} from '../components/ui';

export default function Commissions() {
  const { isAdmin, isAgent } = useAuth();
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [agentSummary, setAgentSummary] = useState(null);
  const [filters, setFilters] = useState({ agentId: '', status: '', from: '', to: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(null);
  const [payingShare, setPayingShare] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editAmount, setEditAmount] = useState('');
  const [editStatus, setEditStatus] = useState('pending');
  const [editShareAmount, setEditShareAmount] = useState('');
  const [editShareStatus, setEditShareStatus] = useState('pending');
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState('');

  const load = async (f = filters) => {
    setLoading(true);
    setError('');
    try {
      const res = await get('/api/commissions' + qs(f));
      setRows(asArray(res));
      // Server envelope: { commissions, summary: { pending, paid },
      // agentSummary: { agentPending, agentPaid } }. Agents receive only
      // agentSummary; fall back to client-computed totals when absent.
      const obj = res && typeof res === 'object' && !Array.isArray(res) ? res : {};
      setSummary(obj.summary || null);
      setAgentSummary(obj.agentSummary || null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load({ agentId: '', status: '', from: '', to: '' }); }, []);

  const setF = (k) => (e) => setFilters((s) => ({ ...s, [k]: e.target.value }));

  const markPaid = async (row) => {
    if (!window.confirm(`Mark commission of ${pkr(row.amount)} as paid?`)) return;
    setPaying(row.id);
    try {
      await post(`/api/commissions/${row.id}/pay`);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setPaying(null);
    }
  };

  const markSharePaid = async (row) => {
    if (!window.confirm(`Mark agent share of ${pkr(row.agentAmount)} as paid?`)) return;
    setPayingShare(row.id);
    try {
      await post(`/api/commissions/${row.id}/pay-agent-share`);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setPayingShare(null);
    }
  };

  // Admin-only manual override: set the owner amount/status and/or the
  // agent share amount/status independent of the auto calculation.
  // Audit-logged server-side.
  const openEdit = (row) => {
    setEditing(row);
    setEditAmount(String(row.amount ?? ''));
    setEditStatus(row.status || 'pending');
    setEditShareAmount(row.agentAmount === null || row.agentAmount === undefined ? '' : String(row.agentAmount));
    setEditShareStatus(row.agentStatus || 'pending');
    setEditError('');
  };

  const saveEdit = async (e) => {
    e.preventDefault();
    if (!editing) return;
    setEditBusy(true);
    setEditError('');
    try {
      const payload = { amount: Number(editAmount), status: editStatus };
      if (editShareAmount !== '') payload.agentAmount = Number(editShareAmount);
      payload.agentStatus = editShareStatus;
      await put(`/api/commissions/${editing.id}`, payload);
      setEditing(null);
      load();
    } catch (err) {
      setEditError(err.message);
    } finally {
      setEditBusy(false);
    }
  };

  // Client-computed fallback totals (used only when the server did not
  // send summary / agentSummary).
  const computed = rows.reduce(
    (s, r) => {
      const amt = Number(r.amount) || 0;
      const share = Number(r.agentAmount) || 0;
      s.ownerAll += amt;
      s.shareAll += share;
      if (String(r.status || '').toLowerCase() === 'paid') s.ownerPaid += amt;
      else s.ownerUnpaid += amt;
      if (String(r.agentStatus || '').toLowerCase() === 'paid') s.sharePaid += share;
      else s.shareUnpaid += share;
      return s;
    },
    { ownerAll: 0, ownerPaid: 0, ownerUnpaid: 0, shareAll: 0, sharePaid: 0, shareUnpaid: 0 }
  );

  const ownerTotals = summary
    ? {
      all: (summary.total ?? (Number(summary.pending) || 0) + (Number(summary.paid) || 0)),
      paid: Number(summary.paid) || 0,
      unpaid: Number(summary.pending) || 0,
    }
    : { all: computed.ownerAll, paid: computed.ownerPaid, unpaid: computed.ownerUnpaid };

  const shareTotals = agentSummary
    ? {
      all: (agentSummary.total ?? (Number(agentSummary.agentPending) || 0) + (Number(agentSummary.agentPaid) || 0)),
      paid: Number(agentSummary.agentPaid) || 0,
      unpaid: Number(agentSummary.agentPending) || 0,
    }
    : { all: computed.shareAll, paid: computed.sharePaid, unpaid: computed.shareUnpaid };

  // Agents see ONLY their share figures — never owner amounts.
  const showOwner = !isAgent;

  return (
    <>
      <PageHeader title="Commissions" sub="Agent earnings across closed and running deals" />

      {error && <Alert kind="error">{error}</Alert>}

      {showOwner && (
        <div className="grid grid-3" style={{ marginBottom: 16 }}>
          <div className="stat accent"><div className="stat-label">Total commission</div><div className="stat-value">{pkr(ownerTotals.all)}</div></div>
          <div className="stat"><div className="stat-label">Paid out</div><div className="stat-value">{pkr(ownerTotals.paid)}</div></div>
          <div className="stat"><div className="stat-label">Unpaid</div><div className="stat-value">{pkr(ownerTotals.unpaid)}</div></div>
        </div>
      )}

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="stat accent"><div className="stat-label">Total agent share</div><div className="stat-value">{pkr(shareTotals.all)}</div></div>
        <div className="stat"><div className="stat-label">Share paid</div><div className="stat-value">{pkr(shareTotals.paid)}</div></div>
        <div className="stat"><div className="stat-label">Share pending</div><div className="stat-value">{pkr(shareTotals.unpaid)}</div></div>
      </div>

      <div className="filter-bar">
        <Field label="Agent ID">
          <input className="input" placeholder="e.g. 3" value={filters.agentId} onChange={setF('agentId')} />
        </Field>
        <Field label="Status">
          <select className="select" value={filters.status} onChange={setF('status')}>
            <option value="">All</option>
            <option value="paid">Paid</option>
            <option value="pending">Pending</option>
          </select>
        </Field>
        <Field label="From"><input className="input" type="date" value={filters.from} onChange={setF('from')} /></Field>
        <Field label="To"><input className="input" type="date" value={filters.to} onChange={setF('to')} /></Field>
        <button className="btn btn-secondary" onClick={() => load()}>Apply</button>
        <button className="btn btn-ghost" onClick={() => { const e = { agentId: '', status: '', from: '', to: '' }; setFilters(e); load(e); }}>Clear</button>
      </div>

      {editing && (
        <Modal title="Set commission manually" onClose={() => setEditing(null)}>
          <form onSubmit={saveEdit}>
            {editError && <Alert kind="error">{editError}</Alert>}
            <p className="muted" style={{ marginTop: 0 }}>
              Overrides the auto-calculated commission for this deal. The change is audit-logged.
            </p>
            <Field label="Total commission (PKR) *">
              <input className="input" type="number" min="0" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} required />
            </Field>
            <Field label="Owner status">
              <select className="select" value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
                <option value="pending">Pending</option>
                <option value="paid">Paid</option>
              </select>
            </Field>
            <hr className="divider" />
            <p className="muted" style={{ marginTop: 0 }}>
              Agent share — the agent&apos;s portion of the owner&apos;s total commission above.
            </p>
            <Field label="Agent share amount (PKR)">
              <input className="input" type="number" min="0" value={editShareAmount} onChange={(e) => setEditShareAmount(e.target.value)} placeholder="Leave empty to keep the current share" />
            </Field>
            <Field label="Agent share status">
              <select className="select" value={editShareStatus} onChange={(e) => setEditShareStatus(e.target.value)}>
                <option value="pending">Pending</option>
                <option value="paid">Paid</option>
              </select>
            </Field>
            <div className="modal-foot">
              <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={editBusy}>{editBusy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}

      {loading ? <Spinner /> : rows.length === 0 ? (
        <Card><EmptyState icon="💰" title="No commissions found" hint="Commissions appear once deals carry commission terms." /></Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th><th>Deal</th><th>Property</th><th>Date</th>
                {showOwner && <th className="num">Total commission</th>}
                <th className="num">Agent share</th>
                {showOwner && <th>Owner status</th>}
                <th>Share status</th>
                {showOwner && <th>Paid at</th>}
                <th>Share paid at</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = String(r.status || 'pending').toLowerCase();
                const shareSt = String(r.agentStatus || 'pending').toLowerCase();
                return (
                  <tr key={r.id}>
                    <td>{r.agentName || r.agent?.name || r.agent?.username || `#${String(r.agentId || '').slice(0, 8)}`}</td>
                    <td>{r.dealId ? <Link to={`/deals/${r.dealId}`}>#{String(r.dealId).slice(0, 8)}</Link> : '—'}</td>
                    <td className="muted">{r.propertyCode || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.createdAt || r.created_at)}</td>
                    {showOwner && (
                      <td className="num">
                        <strong>{pkr(r.amount)}</strong>
                        {r.manual ? <div className="muted" style={{ fontSize: 12 }}>Manual</div> : null}
                      </td>
                    )}
                    <td className="num"><strong>{pkr(r.agentAmount ?? 0)}</strong></td>
                    {showOwner && <td><Badge status={st} /></td>}
                    <td><Badge status={shareSt} /></td>
                    {showOwner && <td className="muted" style={{ whiteSpace: 'nowrap' }}>{r.paidAt || r.paid_at ? fmtDateTime(r.paidAt || r.paid_at) : '—'}</td>}
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>{r.agentPaidAt || r.agent_paid_at ? fmtDateTime(r.agentPaidAt || r.agent_paid_at) : '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {isAdmin && (
                          <button className="btn btn-secondary btn-sm" onClick={() => openEdit(r)}>Set manually</button>
                        )}
                        {isAdmin && st !== 'paid' && (
                          <button className="btn btn-primary btn-sm" disabled={paying === r.id} onClick={() => markPaid(r)}>
                            {paying === r.id ? 'Marking…' : 'Mark paid'}
                          </button>
                        )}
                        {isAdmin && shareSt !== 'paid' && (Number(r.agentAmount) || 0) > 0 && (
                          <button className="btn btn-secondary btn-sm" disabled={payingShare === r.id} onClick={() => markSharePaid(r)}>
                            {payingShare === r.id ? 'Marking…' : 'Mark share paid'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
