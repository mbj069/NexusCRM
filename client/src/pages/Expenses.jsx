import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { get, post, put, del, qs } from '../api';
import { useAuth } from '../auth';
import {
  PageHeader, Card, EmptyState, Spinner, Alert, Field, Modal,
  pkr, fmtDate,
} from '../components/ui';

const CATEGORY_SUGGESTIONS = ['Rent', 'Utilities', 'Salaries', 'Marketing', 'Maintenance', 'Misc'];

function ExpenseForm({ initial, onSaved, onCancel }) {
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({
    date: initial?.date || initial?.createdAt || initial?.created_at
      ? String(initial?.date || initial?.createdAt || initial?.created_at).slice(0, 10)
      : today,
    category: initial?.category || '',
    description: initial?.description || '',
    amount: initial?.amount === null || initial?.amount === undefined ? '' : String(initial.amount),
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!f.category.trim()) { setError('Category is required.'); return; }
    if (f.amount === '' || Number(f.amount) < 0) { setError('Enter a valid amount.'); return; }
    setSaving(true);
    try {
      const payload = {
        date: f.date || today,
        category: f.category.trim(),
        description: f.description.trim(),
        amount: Number(f.amount),
      };
      if (initial?.id) await put(`/api/expenses/${initial.id}`, payload);
      else await post('/api/expenses', payload);
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
        <Field label="Date *">
          <input className="input" type="date" value={f.date} onChange={set('date')} required />
        </Field>
        <Field label="Category *">
          <input
            className="input" list="expense-categories" value={f.category}
            onChange={set('category')} placeholder="e.g. Rent" required
          />
          <datalist id="expense-categories">
            {CATEGORY_SUGGESTIONS.map((c) => <option key={c} value={c} />)}
          </datalist>
        </Field>
      </div>
      <Field label="Description">
        <input className="input" value={f.description} onChange={set('description')} placeholder="e.g. Office rent for November" />
      </Field>
      <Field label="Amount (PKR) *">
        <input className="input" type="number" min="0" step="any" value={f.amount} onChange={set('amount')} placeholder="e.g. 50000" required />
      </Field>
      <div className="modal-foot">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : (initial?.id ? 'Save changes' : 'Add expense')}
        </button>
      </div>
    </form>
  );
}

export default function Expenses() {
  const { isAdmin } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(null);
  const [byCategory, setByCategory] = useState(null);
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState({ category: '', from: '', to: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState(null);

  // Server envelope: { expenses, total, byCategory }. Falls back to a
  // bare array and client-computed totals if the envelope is absent.
  const load = async (f = filters) => {
    setLoading(true);
    setError('');
    try {
      const res = await get('/api/expenses' + qs(f));
      const list = Array.isArray(res?.expenses) ? res.expenses : (Array.isArray(res) ? res : []);
      setRows(list);
      setTotal(res && typeof res === 'object' && !Array.isArray(res) && res.total !== undefined
        ? res.total
        : null);
      setByCategory(res && typeof res === 'object' && !Array.isArray(res) ? res.byCategory || null : null);
      // Category options come from the full (unfiltered) data.
      if (!f.category && !f.from && !f.to) {
        setCategories([...new Set(list.map((x) => x.category).filter(Boolean))].sort());
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load({ category: '', from: '', to: '' });
    // Quick Add from the dashboard navigates here with { openNew: true }.
    if (location.state?.openNew) {
      setShowNew(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, []);

  const setF = (k) => (e) => setFilters((s) => ({ ...s, [k]: e.target.value }));

  const totalSpent = total !== null && total !== undefined
    ? Number(total) || 0
    : rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);

  const topCategory = useMemo(() => {
    const sums = {};
    if (byCategory && typeof byCategory === 'object') {
      Object.entries(byCategory).forEach(([k, v]) => { sums[k] = Number(v) || 0; });
    } else {
      rows.forEach((r) => {
        if (!r.category) return;
        sums[r.category] = (sums[r.category] || 0) + (Number(r.amount) || 0);
      });
    }
    const entries = Object.entries(sums).sort((a, b) => b[1] - a[1]);
    return entries.length ? { name: entries[0][0], amount: entries[0][1] } : null;
  }, [byCategory, rows]);

  const remove = async (row) => {
    if (!window.confirm(`Delete this ${pkr(row.amount)} ${row.category || 'expense'}?`)) return;
    try {
      await del(`/api/expenses/${row.id}`);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const recordedBy = (r) =>
    r.recordedByName || r.recordedBy?.name || r.recordedBy?.username
    || r.createdByName || r.userName || r.createdBy?.name || '—';

  return (
    <>
      <PageHeader
        title="Expenses"
        sub="Office and business spending, tracked by category"
        actions={isAdmin ? <button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New expense</button> : null}
      />

      {error && <Alert kind="error">{error}</Alert>}

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="stat accent"><div className="stat-label">Total spent</div><div className="stat-value">{pkr(totalSpent)}</div></div>
        <div className="stat"><div className="stat-label">Expenses</div><div className="stat-value">{rows.length}</div></div>
        <div className="stat">
          <div className="stat-label">Top category</div>
          <div className="stat-value" style={{ fontSize: 20 }}>{topCategory ? topCategory.name : '—'}</div>
          {topCategory && <div className="stat-sub">{pkr(topCategory.amount)}</div>}
        </div>
      </div>

      <div className="filter-bar">
        <Field label="Category">
          <select className="select" value={filters.category} onChange={setF('category')}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </Field>
        <Field label="From"><input className="input" type="date" value={filters.from} onChange={setF('from')} /></Field>
        <Field label="To"><input className="input" type="date" value={filters.to} onChange={setF('to')} /></Field>
        <button className="btn btn-secondary" onClick={() => load()}>Apply</button>
        <button className="btn btn-ghost" onClick={() => { const e = { category: '', from: '', to: '' }; setFilters(e); load(e); }}>Clear</button>
      </div>

      {loading ? <Spinner /> : rows.length === 0 ? (
        <Card><EmptyState icon="🧾" title="No expenses found" hint="Try a different filter, or add your first expense." /></Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Category</th><th>Description</th><th className="num">Amount</th><th>Recorded by</th>{isAdmin && <th></th>}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(r.date || r.createdAt || r.created_at)}</td>
                  <td><strong>{r.category || '—'}</strong></td>
                  <td className="muted">{r.description || '—'}</td>
                  <td className="num"><strong>{pkr(r.amount)}</strong></td>
                  <td className="muted">{recordedBy(r)}</td>
                  {isAdmin && (
                    <td>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => setEditing(r)}>Edit</button>
                        <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red-600)' }} onClick={() => remove(r)}>Delete</button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <Modal title="New expense" onClose={() => setShowNew(false)}>
          <ExpenseForm onCancel={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />
        </Modal>
      )}
      {editing && (
        <Modal title="Edit expense" onClose={() => setEditing(null)}>
          <ExpenseForm initial={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
        </Modal>
      )}
    </>
  );
}
