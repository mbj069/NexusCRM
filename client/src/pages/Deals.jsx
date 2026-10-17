import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post, put, qs, asArray } from '../api';
import {
  PageHeader, Card, Badge, Modal, EmptyState, Spinner, Alert, Field,
  pkr, fmtDate, fmtDateTime, prettyLabel, BackLink,
} from '../components/ui';
import DealModal from '../components/DealModal';
import { DocumentsPanel } from './Contacts';

const DEAL_STAGES = ['proposed', 'token_paid', 'in_progress', 'closed_won', 'closed_lost', 'cancelled'];
const KIND_ICONS = { note: '📝', call: '📞', viewing: '👁️', message: '💬', stage_change: '🔀' };

export function Deals() {
  const [deals, setDeals] = useState([]);
  const [stage, setStage] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);

  const load = async (s = stage) => {
    setLoading(true);
    setError('');
    try {
      setDeals(asArray(await get('/api/deals' + qs({ stage: s }))));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(''); }, []);

  return (
    <>
      <PageHeader
        title="Deals"
        sub="From proposal to registry — every deal in one pipeline"
        actions={<button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New deal</button>}
      />

      <div className="filter-bar">
        <Field label="Stage">
          <select className="select" value={stage} onChange={(e) => { setStage(e.target.value); load(e.target.value); }}>
            <option value="">All stages</option>
            {DEAL_STAGES.map((s) => <option key={s} value={s}>{prettyLabel(s)}</option>)}
          </select>
        </Field>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      {loading ? <Spinner /> : deals.length === 0 ? (
        <Card><EmptyState icon="🤝" title="No deals yet" hint="Create a deal from a lead or an available property." /></Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Deal</th><th>Lead</th><th>Property</th><th>Stage</th><th className="num">Deal value</th><th className="num">Bayana</th><th></th></tr>
            </thead>
            <tbody>
              {deals.map((d) => (
                <tr key={d.id}>
                  <td><Link to={`/deals/${d.id}`}><strong>#{d.id}</strong></Link></td>
                  <td>{d.leadName || d.lead?.name || '—'}</td>
                  <td>{d.propertyTitle || d.property?.title || d.propertyCode || d.property?.code || '—'}</td>
                  <td><Badge status={d.stage} /></td>
                  <td className="num">{d.dealValue ? pkr(d.dealValue) : '—'}</td>
                  <td className="num">{d.bayanaAmount ? pkr(d.bayanaAmount) : '—'}</td>
                  <td><Link to={`/deals/${d.id}`} className="btn btn-ghost btn-sm">Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && <DealModal onClose={() => setShowNew(false)} />}
    </>
  );
}

/* ================= Deal detail ================= */

function PlanGenerator({ deal, lead, onCreated }) {
  const [contacts, setContacts] = useState([]);
  const [contactQ, setContactQ] = useState('');
  const [contactId, setContactId] = useState('');
  const [form, setForm] = useState({ downPayment: '', numInstallments: '12', installmentAmount: '', possessionAmount: '', startDate: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((s) => ({ ...s, [k]: e.target.value }));

  useEffect(() => {
    const leadContactId = lead?.contactId || lead?.contact_id || lead?.contact?.id;
    if (leadContactId) {
      setContactId(String(leadContactId));
      (async () => {
        try {
          const c = await get(`/api/contacts/${leadContactId}`);
          setContacts(asArray([c.contact || c]));
          setContactQ((c.contact || c).name || '');
        } catch { /* ignore */ }
      })();
    }
  }, [lead]);

  const searchContacts = async (value) => {
    setContactQ(value);
    if (value.trim().length < 2) return;
    try {
      setContacts(asArray(await get('/api/contacts' + qs({ q: value.trim() }))));
    } catch { /* ignore */ }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!contactId) { setError('Pick the buyer contact for this plan.'); return; }
    if (!form.numInstallments || !form.startDate) { setError('Number of installments and start date are required.'); return; }
    setBusy(true);
    try {
      const payload = {
        dealId: deal.id,
        contactId,
        numInstallments: Number(form.numInstallments),
        startDate: form.startDate,
      };
      ['downPayment', 'installmentAmount', 'possessionAmount'].forEach((k) => {
        if (form[k] !== '') payload[k] = Number(form[k]);
      });
      const plan = await post('/api/plans', payload);
      onCreated(plan.plan || plan);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {error && <Alert kind="error">{error}</Alert>}
      <Field label="Buyer (contact) *">
        <input
          className="input" list="plan-contact-list" placeholder="Type to search contacts…"
          value={contactQ}
          onChange={(e) => {
            searchContacts(e.target.value);
            const match = contacts.find((c) => c.name === e.target.value);
            setContactId(match ? String(match.id) : '');
          }}
        />
        <datalist id="plan-contact-list">
          {contacts.map((c) => <option key={c.id} value={c.name}>{c.phone || ''}</option>)}
        </datalist>
        <div className="hint">The person paying the installments.</div>
      </Field>
      <div className="form-row">
        <Field label="Down payment (PKR)"><input className="input" type="number" min="0" value={form.downPayment} onChange={set('downPayment')} /></Field>
        <Field label="Possession amount (PKR)"><input className="input" type="number" min="0" value={form.possessionAmount} onChange={set('possessionAmount')} /></Field>
      </div>
      <div className="form-row">
        <Field label="No. of installments *"><input className="input" type="number" min="1" value={form.numInstallments} onChange={set('numInstallments')} required /></Field>
        <Field label="Installment amount (PKR)"><input className="input" type="number" min="0" value={form.installmentAmount} onChange={set('installmentAmount')} /></Field>
      </div>
      <Field label="Start date *"><input className="input" type="date" value={form.startDate} onChange={set('startDate')} required /></Field>
      <div className="hint" style={{ marginBottom: 8 }}>
        Down payment + (installments × amount) + possession must equal the deal value{deal.dealValue ? ` (${pkr(deal.dealValue)})` : ''}.
      </div>
      <div className="modal-foot">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Generating…' : 'Generate plan'}</button>
      </div>
    </form>
  );
}

export function DealDetail() {
  const { id } = useParams();
  const [deal, setDeal] = useState(null);
  const [plans, setPlans] = useState([]);
  const [commissions, setCommissions] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [stageBusy, setStageBusy] = useState(false);
  const [showPlanGen, setShowPlanGen] = useState(false);
  const [actKind, setActKind] = useState('note');
  const [actText, setActText] = useState('');
  const [actBusy, setActBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      // GET /api/deals/:id embeds lead, property, plans, commissions and activities.
      const d = await get(`/api/deals/${id}`);
      const dealObj = d.deal || d;
      setDeal(dealObj);
      setPlans(asArray(dealObj.plans));
      setCommissions(asArray(dealObj.commissions));
      setActivities(asArray(dealObj.activities));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]);

  const changeStage = async (stage) => {
    setStageBusy(true);
    setNotice('');
    try {
      const res = await post(`/api/deals/${id}/stage`, { stage });
      setDeal(res.deal || res || { ...deal, stage });
    } catch (e) {
      setNotice(e.message);
    } finally {
      setStageBusy(false);
    }
  };

  const addActivity = async (e) => {
    e.preventDefault();
    if (!actText.trim()) return;
    setActBusy(true);
    try {
      await post('/api/activities', { entityType: 'deal', entityId: id, kind: actKind, text: actText.trim() });
      setActText('');
      load();
    } catch (err) {
      setNotice(err.message);
    } finally {
      setActBusy(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return (<><BackLink to="/deals" label="Deals" /><Alert kind="error">{error}</Alert></>);
  if (!deal) return (<><BackLink to="/deals" label="Deals" /><Alert kind="error">Deal not found.</Alert></>);

  const lead = deal.lead || {};
  const property = deal.property || {};

  return (
    <>
      <BackLink to="/deals" label="Deals" />
      <PageHeader
        title={`Deal #${deal.id}`}
        sub={deal.createdAt ? `Opened ${fmtDate(deal.createdAt)}` : ''}
        actions={
          <button className="btn btn-primary" onClick={() => setShowPlanGen(true)}>+ Payment plan</button>
        }
      />

      {notice && <Alert kind="error">{notice}</Alert>}

      <div className="grid grid-2">
        <Card title="Lead" actions={lead.id ? <Link to={`/leads/${lead.id}`} className="btn btn-ghost btn-sm">Open →</Link> : null}>
          {lead.id || lead.name ? (
            <dl className="kv">
              <dt>Name</dt><dd>{lead.name || '—'}</dd>
              <dt>Phone</dt><dd>{lead.phone || '—'}</dd>
              <dt>Stage</dt><dd><Badge status={lead.stage} /></dd>
            </dl>
          ) : <EmptyState icon="🎯" title="No lead linked" />}
        </Card>
        <Card title="Property" actions={property.id ? <Link to={`/inventory/${property.id}`} className="btn btn-ghost btn-sm">Open →</Link> : null}>
          {property.id || property.title ? (
            <dl className="kv">
              <dt>Title</dt><dd>{property.title || property.code || '—'}</dd>
              <dt>Location</dt><dd>{property.location || '—'}</dd>
              <dt>Status</dt><dd><Badge status={property.status} /></dd>
              <dt>Price</dt><dd>{property.price ? pkr(property.price) : '—'}</dd>
            </dl>
          ) : <EmptyState icon="🏘️" title="No property linked" />}
        </Card>
      </div>

      <Card title="Deal terms" className="section-gap">
        <dl className="kv">
          <dt>Stage</dt><dd><Badge status={deal.stage} /></dd>
          <dt>Deal value</dt><dd><strong>{deal.dealValue ? pkr(deal.dealValue) : '—'}</strong></dd>
          <dt>Bayana / token money</dt><dd>{deal.bayanaAmount ? pkr(deal.bayanaAmount) : '—'}</dd>
          <dt>Commission</dt>
          <dd>
            {deal.commissionValue
              ? deal.commissionType === 'percent'
                ? `${deal.commissionValue}% of deal value`
                : pkr(deal.commissionValue)
              : '—'}
          </dd>
          <dt>Agent</dt><dd>{deal.agentName || deal.agent?.name || deal.agent?.username || '—'}</dd>
          <dt>Notes</dt><dd>{deal.notes || '—'}</dd>
        </dl>
        <div className="stage-actions">
          <span className="label" style={{ alignSelf: 'center', marginRight: 4 }}>Move to:</span>
          {DEAL_STAGES.filter((s) => s !== deal.stage).map((s) => (
            <button key={s} className="btn btn-secondary btn-sm" disabled={stageBusy} onClick={() => changeStage(s)}>
              {prettyLabel(s)}
            </button>
          ))}
        </div>
      </Card>

      <Card
        title="Payment plans"
        className="section-gap"
        actions={<button className="btn btn-secondary btn-sm" onClick={() => setShowPlanGen(true)}>+ New plan</button>}
      >
        {plans.length === 0 ? (
          <EmptyState icon="💳" title="No payment plan yet" hint="Generate an installment plan for the buyer." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Plan</th><th className="num">Total</th><th className="num">Down payment</th><th className="num">Installments</th><th>Start</th><th></th></tr>
              </thead>
              <tbody>
                {plans.map((p) => (
                  <tr key={p.id}>
                    <td><strong>Plan #{String(p.id).slice(0, 8)}</strong></td>
                    <td className="num">{pkr(p.totalAmount)}</td>
                    <td className="num">{pkr(p.downPayment)}</td>
                    <td className="num">{p.numInstallments ? `${p.numInstallments} × ${pkr(p.installmentAmount)}` : '—'}</td>
                    <td>{fmtDate(p.startDate)}</td>
                    <td><Link to={`/payments/plans/${p.id}`} className="btn btn-ghost btn-sm">Open →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Commissions" className="section-gap">
        {commissions.length === 0 ? (
          <EmptyState icon="💰" title="No commissions on this deal" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Agent</th><th className="num">Amount</th><th>Status</th><th>Paid at</th></tr></thead>
              <tbody>
                {commissions.map((c) => (
                  <tr key={c.id}>
                    <td>{c.agentName || c.agent?.name || '—'}</td>
                    <td className="num"><strong>{pkr(c.amount)}</strong></td>
                    <td><Badge status={c.status} /></td>
                    <td className="muted">{c.paidAt ? fmtDateTime(c.paidAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-2 section-gap">
        <Card title="Documents">
          <DocumentsPanel entityType="deal" entityId={deal.id} />
        </Card>
        <Card title="Activity">
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
              <textarea className="textarea" value={actText} onChange={(e) => setActText(e.target.value)} placeholder="Log progress on this deal…" />
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
      </div>

      {showPlanGen && (
        <Modal title="Generate payment plan" onClose={() => setShowPlanGen(false)} wide>
          <PlanGenerator
            deal={deal}
            lead={lead}
            onCreated={(plan) => {
              setShowPlanGen(false);
              if (plan?.id) window.location.href = `/payments/plans/${plan.id}`;
              else load();
            }}
          />
        </Modal>
      )}
    </>
  );
}

// Small shim so the plan generator can update a deal if the backend supports it.
export async function updateDeal(id, payload) {
  return put(`/api/deals/${id}`, payload);
}
