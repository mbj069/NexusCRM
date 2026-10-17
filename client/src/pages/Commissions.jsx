import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, qs, asArray } from '../api';
import { useAuth } from '../auth';
import {
  PageHeader, Card, Badge, EmptyState, Spinner, Alert, Field,
  pkr, fmtDate,
} from '../components/ui';

export default function Commissions() {
  const { isManager } = useAuth();
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ agentId: '', status: '', from: '', to: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(null);

  const load = async (f = filters) => {
    setLoading(true);
    setError('');
    try {
      setRows(asArray(await get('/api/commissions' + qs(f))));
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

  const totals = rows.reduce(
    (s, r) => {
      const amt = Number(r.amount) || 0;
      s.all += amt;
      const st = String(r.status || '').toLowerCase();
      if (st === 'paid') s.paid += amt;
      else s.unpaid += amt;
      return s;
    },
    { all: 0, paid: 0, unpaid: 0 }
  );

  return (
    <>
      <PageHeader title="Commissions" sub="Agent earnings across closed and running deals" />

      {error && <Alert kind="error">{error}</Alert>}

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="stat accent"><div className="stat-label">Total commission</div><div className="stat-value">{pkr(totals.all)}</div></div>
        <div className="stat"><div className="stat-label">Paid out</div><div className="stat-value">{pkr(totals.paid)}</div></div>
        <div className="stat"><div className="stat-label">Unpaid</div><div className="stat-value">{pkr(totals.unpaid)}</div></div>
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

      {loading ? <Spinner /> : rows.length === 0 ? (
        <Card><EmptyState icon="💰" title="No commissions found" hint="Commissions appear once deals carry commission terms." /></Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Agent</th><th>Deal</th><th>Property</th><th>Date</th><th className="num">Amount</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const st = String(r.status || 'pending').toLowerCase();
                return (
                  <tr key={r.id}>
                    <td>{r.agentName || r.agent?.name || r.agent?.username || `#${String(r.agentId || '').slice(0, 8)}`}</td>
                    <td>{r.dealId ? <Link to={`/deals/${r.dealId}`}>#{String(r.dealId).slice(0, 8)}</Link> : '—'}</td>
                    <td className="muted">{r.propertyCode || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.createdAt || r.created_at)}</td>
                    <td className="num"><strong>{pkr(r.amount)}</strong></td>
                    <td><Badge status={st} /></td>
                    <td>
                      {isManager && st !== 'paid' && (
                        <button className="btn btn-primary btn-sm" disabled={paying === r.id} onClick={() => markPaid(r)}>
                          {paying === r.id ? 'Marking…' : 'Mark paid'}
                        </button>
                      )}
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
