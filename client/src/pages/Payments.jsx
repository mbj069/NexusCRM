import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { get, post, qs, asArray } from '../api';
import {
  PageHeader, Card, Badge, Modal, EmptyState, Spinner, Alert, Field,
  pkr, fmtDate, fmtDateTime, prettyLabel, BackLink,
} from '../components/ui';

const PAY_METHODS = ['cash', 'bank', 'transfer'];

function RecordPaymentModal({ scheduleRow, planId, onClose, onSaved }) {
  const [form, setForm] = useState({
    amount: scheduleRow?.amount ?? scheduleRow?.remaining ?? '',
    method: 'cash',
    notes: '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!form.amount || Number(form.amount) <= 0) { setError('Enter a valid amount.'); return; }
    setBusy(true);
    try {
      await post('/api/payments', {
        scheduleId: scheduleRow.id,
        amount: Number(form.amount),
        method: form.method,
        notes: form.notes || undefined,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Record payment" onClose={onClose}>
      <form onSubmit={submit}>
        {error && <Alert kind="error">{error}</Alert>}
        <p className="muted" style={{ marginTop: 0 }}>
          {scheduleRow?.label || `Installment due ${fmtDate(scheduleRow?.dueDate || scheduleRow?.due_date)}`}
          {scheduleRow?.amount ? ` · ${pkr(scheduleRow.amount)}` : ''}
        </p>
        <div className="form-row">
          <Field label="Amount (PKR) *">
            <input className="input" type="number" min="1" value={form.amount} onChange={set('amount')} required />
          </Field>
          <Field label="Method">
            <select className="select" value={form.method} onChange={set('method')}>
              {PAY_METHODS.map((m) => <option key={m} value={m}>{prettyLabel(m)}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Notes">
          <input className="input" value={form.notes} onChange={set('notes')} placeholder="e.g. received in office, cheque #123" />
        </Field>
        <div className="modal-foot">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Recording…' : 'Record payment'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function Payments() {
  const [plans, setPlans] = useState([]);
  const [contactNames, setContactNames] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ledgerQ, setLedgerQ] = useState('');
  const [ledgerResults, setLedgerResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [pl, cs] = await Promise.all([
        get('/api/plans'),
        get('/api/contacts').catch(() => []),
      ]);
      setPlans(asArray(pl));
      const map = {};
      asArray(cs).forEach((c) => { map[c.id] = c.name; });
      setContactNames(map);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const searchLedger = async () => {
    if (ledgerQ.trim().length < 2) return;
    setSearching(true);
    try {
      const res = await get('/api/contacts' + qs({ q: ledgerQ.trim() }));
      setLedgerResults(asArray(res));
    } catch (e) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  };

  return (
    <>
      <PageHeader title="Payments" sub="Installment plans, schedules and receipts" />

      {error && <Alert kind="error">{error}</Alert>}

      <Card title="Payment plans">
        {loading ? <Spinner /> : plans.length === 0 ? (
          <EmptyState icon="💳" title="No payment plans yet" hint="Generate one from a deal's page." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Plan</th><th>Contact</th><th>Deal</th><th className="num">Total</th><th className="num">Down payment</th><th className="num">Installments</th><th></th></tr>
              </thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id}>
                    <td><strong>#{String(p.id).slice(0, 8)}</strong><div className="muted">from {fmtDate(p.startDate)}</div></td>
                    <td>{contactNames[p.contactId] || p.contact?.name || '—'}</td>
                    <td>{p.dealId ? <Link to={`/deals/${p.dealId}`}>#{String(p.dealId).slice(0, 8)}</Link> : '—'}</td>
                    <td className="num">{pkr(p.totalAmount)}</td>
                    <td className="num">{pkr(p.downPayment)}</td>
                    <td className="num">{p.numInstallments ? `${p.numInstallments} × ${pkr(p.installmentAmount)}` : '—'}</td>
                    <td><Link to={`/payments/plans/${p.id}`} className="btn btn-ghost btn-sm">Open →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Contact ledger lookup" className="section-gap">
        <div className="filter-bar" style={{ marginBottom: 0, border: 'none', padding: 0, boxShadow: 'none' }}>
          <Field label="Search contact">
            <input className="input" style={{ minWidth: 240 }} placeholder="Name or phone…" value={ledgerQ}
              onChange={(e) => setLedgerQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') searchLedger(); }} />
          </Field>
          <button className="btn btn-secondary" onClick={searchLedger} disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        {ledgerResults.length > 0 && (
          <div className="timeline mt-3">
            {ledgerResults.map((c) => (
              <div key={c.id} className="tl-item">
                <div className="tl-dot">📒</div>
                <div className="tl-body flex-between" style={{ width: '100%' }}>
                  <div><strong>{c.name}</strong><div className="tl-meta">{c.phone || ''}</div></div>
                  <button className="btn btn-ghost btn-sm" onClick={() => navigate(`/payments/ledgers/${c.id}`)}>Open ledger →</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}

/* ================= Plan detail ================= */

export function PlanDetail() {
  const { id } = useParams();
  const [plan, setPlan] = useState(null);
  const [schedule, setSchedule] = useState([]);
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [payRow, setPayRow] = useState(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      // GET /api/plans/:id returns the plan with embedded contact, deal, schedule and payments.
      const p = await get(`/api/plans/${id}`);
      const planObj = p.plan || p;
      setPlan(planObj);
      setSchedule(asArray(planObj.schedule));
      setPayments(asArray(planObj.payments));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  if (loading) return <Spinner />;
  if (error) return (<><BackLink to="/payments" label="Payments" /><Alert kind="error">{error}</Alert></>);
  if (!plan) return (<><BackLink to="/payments" label="Payments" /><Alert kind="error">Plan not found.</Alert></>);

  const totals = {
    total: plan.totalAmount,
    paid: plan.totalPaid,
    remaining: plan.balance,
    overdue: schedule
      .filter((r) => String(r.status).toLowerCase() === 'overdue')
      .reduce((s, r) => s + (Number(r.amount) - Number(r.paidAmount || 0)), 0),
  };
  const today = new Date().toISOString().slice(0, 10);

  const rowStatus = (r) => String(r.status || 'pending').toLowerCase();

  return (
    <>
      <BackLink to="/payments" label="Payments" />
      <PageHeader
        title={`Payment plan #${String(plan.id).slice(0, 8)}`}
        sub={plan.contact?.name || ''}
        actions={plan.dealId ? <Link to={`/deals/${plan.dealId}`} className="btn btn-secondary btn-sm">Deal #{String(plan.dealId).slice(0, 8)} →</Link> : null}
      />

      {notice && <Alert kind="error">{notice}</Alert>}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="stat"><div className="stat-label">Plan total</div><div className="stat-value">{pkr(totals.total)}</div></div>
        <div className="stat"><div className="stat-label">Paid</div><div className="stat-value">{pkr(totals.paid)}</div></div>
        <div className="stat"><div className="stat-label">Remaining</div><div className="stat-value">{pkr(totals.remaining)}</div></div>
        <div className="stat"><div className="stat-label">Overdue</div><div className="stat-value">{pkr(totals.overdue)}</div></div>
      </div>

      <Card title="Installment schedule">
        {schedule.length === 0 ? (
          <EmptyState icon="📅" title="No schedule rows" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>#</th><th>Type</th><th>Due date</th><th className="num">Amount</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {schedule.map((r, i) => {
                  const st = rowStatus(r);
                  const isOverdue = st === 'overdue';
                  return (
                    <tr key={r.id || i} className={isOverdue ? 'overdue-row' : ''}>
                      <td>{r.seq ?? i}</td>
                      <td><Badge status={r.kind} /></td>
                      <td>{fmtDate(r.dueDate || r.due_date)}</td>
                      <td className="num">{pkr(r.amount)}</td>
                      <td><Badge status={st} /></td>
                      <td>
                        {st !== 'paid' && (
                          <button className="btn btn-primary btn-sm" onClick={() => setPayRow(r)}>Record payment</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Receipts" className="section-gap">
        {payments.length === 0 ? (
          <EmptyState icon="🧾" title="No payments recorded" hint="Record a payment against a schedule row above." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Receipt</th><th>Date</th><th className="num">Amount</th><th>Method</th><th>Received by</th><th></th></tr></thead>
              <tbody>
                {payments.map((pm) => (
                  <tr key={pm.id}>
                    <td className="mono"><strong>{pm.receiptNo || `#${String(pm.id).slice(0, 8)}`}</strong></td>
                    <td>{fmtDateTime(pm.paidAt || pm.paid_at || pm.createdAt || pm.created_at)}</td>
                    <td className="num">{pkr(pm.amount)}</td>
                    <td><Badge status={pm.method} /></td>
                    <td className="muted">{pm.receivedByName || '—'}</td>
                    <td>
                      <a className="btn btn-ghost btn-sm" href={`/api/receipts/${pm.id}/html`} target="_blank" rel="noreferrer">
                        🖨️ Print receipt
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {payRow && (
        <RecordPaymentModal
          scheduleRow={payRow}
          planId={plan.id}
          onClose={() => setPayRow(null)}
          onSaved={() => { setPayRow(null); load(); }}
        />
      )}
    </>
  );
}

/* ================= Ledger view ================= */

export function LedgerView() {
  const { contactId } = useParams();
  const [ledger, setLedger] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        setLedger(await get(`/api/ledgers/${contactId}`));
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, [contactId]);

  if (loading) return <Spinner />;
  if (error) return (<><BackLink to="/payments" label="Payments" /><Alert kind="error">{error}</Alert></>);

  const contact = ledger?.contact || {};
  const plans = asArray(ledger?.plans);
  const totals = ledger?.totals || {};
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <BackLink to="/payments" label="Payments" />
      <PageHeader
        title={`Ledger — ${contact.name || 'Contact'}`}
        sub={contact.phone || ''}
      />

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="stat accent"><div className="stat-label">Total planned</div><div className="stat-value">{pkr(totals.total)}</div></div>
        <div className="stat"><div className="stat-label">Total paid</div><div className="stat-value">{pkr(totals.paid)}</div></div>
        <div className="stat"><div className="stat-label">Overdue</div><div className="stat-value">{pkr(totals.overdue)}</div></div>
        <div className="stat"><div className="stat-label">Balance</div><div className="stat-value">{pkr(totals.balance ?? totals.remaining)}</div></div>
      </div>

      {plans.length === 0 ? (
        <Card><EmptyState icon="📒" title="No plans for this contact" /></Card>
      ) : (
        plans.map((p, i) => {
          const sched = asArray(p.schedule);
          return (
            <Card
              key={p.id || i}
              title={`${p.propertyTitle || p.propertyCode || `Plan #${String(p.id).slice(0, 8)}`}`}
              className="section-gap"
              actions={
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <Badge status={p.dealStage} />
                  <Link to={`/payments/plans/${p.id}`} className="btn btn-ghost btn-sm">Open plan →</Link>
                </span>
              }
            >
              <div className="flex-between" style={{ marginBottom: 10 }}>
                <span className="muted">
                  Planned <strong>{pkr(p.totalAmount)}</strong>
                  {' · '}Paid <strong>{pkr(p.totalPaid)}</strong>
                  {' · '}Overdue <strong>{pkr(p.overdueAmount)}</strong>
                  {' · '}Balance <strong>{pkr(p.balance)}</strong>
                </span>
                {p.dealId && <Link to={`/deals/${p.dealId}`} className="btn btn-ghost btn-sm">Deal #{String(p.dealId).slice(0, 8)} →</Link>}
              </div>
              {sched.length > 0 && (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>#</th><th>Type</th><th>Due date</th><th className="num">Amount</th><th>Status</th></tr></thead>
                    <tbody>
                      {sched.map((r, j) => {
                        const st = String(r.status || 'pending').toLowerCase();
                        return (
                          <tr key={r.id || j} className={st === 'overdue' ? 'overdue-row' : ''}>
                            <td>{r.seq ?? j}</td>
                            <td><Badge status={r.kind} /></td>
                            <td>{fmtDate(r.dueDate || r.due_date)}</td>
                            <td className="num">{pkr(r.amount)}</td>
                            <td><Badge status={st} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          );
        })
      )}
    </>
  );
}
