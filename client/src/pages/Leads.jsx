import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { get, post, put, del, qs, asArray } from '../api';
import { useAuth } from '../auth';
import {
  PageHeader, Card, Badge, Modal, EmptyState, Spinner, Alert, Field,
  pkr, fmtDateTime, fmtDate, prettyLabel, WaButton, BackLink, statusColor,
} from '../components/ui';
import DealModal from '../components/DealModal';

const LEAD_STAGES = ['new', 'contacted', 'viewing', 'negotiating', 'won', 'lost'];
const ACTIVITY_KINDS = ['note', 'call', 'viewing', 'message'];
const KIND_ICONS = { note: '📝', call: '📞', viewing: '👁️', message: '💬', stage_change: '🔀' };

function LeadForm({ initial, agents = [], canAssign = false, onSaved, onCancel }) {
  const [f, setF] = useState({
    name: '', phone: '', whatsapp: '', intent: 'buy', society: '', source: '',
    notes: '', interest: '', budgetMin: '', budgetMax: '', assignedTo: '',
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
      ['budgetMin', 'budgetMax'].forEach((k) => { if (payload[k] === '') delete payload[k]; else payload[k] = Number(payload[k]); });
      if (!canAssign) delete payload.assignedTo;
      Object.keys(payload).forEach((k) => { if (payload[k] === '') delete payload[k]; });
      if (initial?.id) await put(`/api/leads/${initial.id}`, payload);
      else await post('/api/leads', payload);
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
        <Field label="Intent">
          <select className="select" value={f.intent || 'buy'} onChange={set('intent')}>
            <option value="buy">🛒 Buy</option>
            <option value="sell">🏷️ Sell</option>
            <option value="rent">🏠 Rent</option>
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Phone"><input className="input" value={f.phone} onChange={set('phone')} placeholder="03xx-xxxxxxx" /></Field>
        <Field label="WhatsApp"><input className="input" value={f.whatsapp} onChange={set('whatsapp')} placeholder="Defaults to phone if empty" /></Field>
      </div>
      <div className="form-row">
        <Field label="Society"><input className="input" value={f.society || ''} onChange={set('society')} placeholder="e.g. Model City, Gulberg City" /></Field>
        <Field label="Source"><input className="input" value={f.source} onChange={set('source')} placeholder="e.g. Facebook, referral, walk-in" /></Field>
      </div>
      <Field label="Interest"><input className="input" value={f.interest} onChange={set('interest')} placeholder="e.g. 5 marla plot in Model City" /></Field>
      {canAssign && (
        <Field label="Assign to agent">
          <select className="select" value={f.assignedTo || ''} onChange={set('assignedTo')}>
            <option value="">Unassigned</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}
      <div className="form-row">
        <Field label="Budget min (PKR)"><input className="input" type="number" min="0" value={f.budgetMin} onChange={set('budgetMin')} /></Field>
        <Field label="Budget max (PKR)"><input className="input" type="number" min="0" value={f.budgetMax} onChange={set('budgetMax')} /></Field>
      </div>
      <Field label="Notes"><textarea className="textarea" value={f.notes} onChange={set('notes')} /></Field>
      <div className="modal-foot">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : (initial?.id ? 'Save changes' : 'Add lead')}</button>
      </div>
    </form>
  );
}

export function Leads() {
  const { canAssign } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [leads, setLeads] = useState([]);
  const [stage, setStage] = useState('');
  const [intent, setIntent] = useState('');
  const [society, setSociety] = useState('');
  const [societies, setSocieties] = useState([]);
  const [agents, setAgents] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showNew, setShowNew] = useState(false);

  const load = async (s = stage, query = q, intentF = intent, societyF = society) => {
    setLoading(true);
    setError('');
    try {
      const rows = asArray(await get('/api/leads' + qs({ stage: s, q: query, intent: intentF, society: societyF })));
      setLeads(rows);
      // Society filter options come from the full (unfiltered) data.
      if (!s && !query && !intentF && !societyF) {
        setSocieties([...new Set(rows.map((l) => l.society).filter(Boolean))].sort());
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load('', '', '', '');
    if (canAssign) get('/api/users/agents').then((r) => setAgents(asArray(r))).catch(() => {});
    // Quick Add from the dashboard navigates here with { openNew: true }.
    if (location.state?.openNew) {
      setShowNew(true);
      navigate(location.pathname, { replace: true, state: {} });
    }
  }, []);

  const stageOptions = useMemo(() => {
    const seen = new Set(leads.map((l) => l.stage).filter(Boolean));
    LEAD_STAGES.forEach((s) => seen.add(s));
    return [...seen];
  }, [leads]);

  const applyFilters = () => load(stage, q, intent, society);

  return (
    <>
      <PageHeader
        title="Leads"
        sub="Every prospect, tracked from first contact to token money"
        actions={<button className="btn btn-primary" onClick={() => setShowNew(true)}>+ New lead</button>}
      />

      <div className="filter-bar">
        <Field label="Stage">
          <select className="select" value={stage} onChange={(e) => { setStage(e.target.value); load(e.target.value, q, intent, society); }}>
            <option value="">All stages</option>
            {stageOptions.map((s) => <option key={s} value={s}>{prettyLabel(s)}</option>)}
          </select>
        </Field>
        <Field label="Buy / Sell / Rent">
          <select className="select" value={intent} onChange={(e) => { setIntent(e.target.value); load(stage, q, e.target.value, society); }}>
            <option value="">Buy, Sell &amp; Rent</option>
            <option value="buy">🛒 Buy</option>
            <option value="sell">🏷️ Sell</option>
            <option value="rent">🏠 Rent</option>
          </select>
        </Field>
        <Field label="Society">
          <select className="select" value={society} onChange={(e) => { setSociety(e.target.value); load(stage, q, intent, e.target.value); }}>
            <option value="">All societies</option>
            {societies.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Search" hint="">
          <input className="input" style={{ minWidth: 220 }} placeholder="Name, phone, interest…" value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyFilters(); }} />
        </Field>
        <button className="btn btn-secondary" onClick={applyFilters}>Search</button>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      {loading ? <Spinner /> : leads.length === 0 ? (
        <Card><EmptyState icon="🎯" title="No leads found" hint="Try a different filter, or add your first lead." /></Card>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Name</th><th>Phone</th><th>Intent</th><th>Stage</th><th>Society</th><th>Assigned to</th><th>Interest</th><th className="num">Budget</th><th></th></tr>
            </thead>
            <tbody>
              {leads.map((l) => (
                <tr key={l.id}>
                  <td><Link to={`/leads/${l.id}`}><strong>{l.name}</strong></Link></td>
                  <td>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {l.phone || '—'}
                      <WaButton phone={l.whatsapp || l.phone} name={l.name} />
                    </span>
                  </td>
                  <td><Badge status={l.intent || 'buy'} /></td>
                  <td><Badge status={l.stage} /></td>
                  <td className="muted">{l.society || '—'}</td>
                  <td className="muted">{l.assignedName || 'Unassigned'}</td>
                  <td className="muted">{l.interest || '—'}</td>
                  <td className="num">{l.budgetMax ? pkr(l.budgetMax) : l.budgetMin ? pkr(l.budgetMin) + '+' : '—'}</td>
                  <td><Link to={`/leads/${l.id}`} className="btn btn-ghost btn-sm">Open →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNew && (
        <Modal title="New lead" onClose={() => setShowNew(false)} wide>
          <LeadForm agents={agents} canAssign={canAssign} onCancel={() => setShowNew(false)} onSaved={() => { setShowNew(false); load('', '', '', ''); }} />
        </Modal>
      )}
    </>
  );
}

/* ================= Lead detail ================= */

export function LeadDetail() {
  const { id } = useParams();
  const { user, canAssign } = useAuth();
  const [lead, setLead] = useState(null);
  const [activities, setActivities] = useState([]);
  const [followups, setFollowups] = useState([]);
  const [score, setScore] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showEdit, setShowEdit] = useState(false);
  const [showDeal, setShowDeal] = useState(false);
  const [scoring, setScoring] = useState(false);
  const [aiScoring, setAiScoring] = useState(false);
  const [agents, setAgents] = useState([]);
  const [assignTo, setAssignTo] = useState('');
  const [assignBusy, setAssignBusy] = useState(false);

  const [actKind, setActKind] = useState('note');
  const [actText, setActText] = useState('');
  const [actBusy, setActBusy] = useState(false);

  const [fuTitle, setFuTitle] = useState('');
  const [fuDate, setFuDate] = useState('');
  const [fuBusy, setFuBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [l, a, f] = await Promise.all([
        get(`/api/leads/${id}`),
        get(`/api/activities/lead/${id}`).catch(() => []),
        get('/api/followups').catch(() => []),
      ]);
      const leadRow = l.lead || l;
      setLead(leadRow);
      setAssignTo(leadRow.assignedTo || '');
      setActivities(asArray(a));
      const mine = asArray(f).filter((x) => String(x.entityId) === String(id) && (x.entityType === 'lead'));
      setFollowups(mine);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    if (canAssign) get('/api/users/agents').then((r) => setAgents(asArray(r))).catch(() => {});
  }, [id]);

  const assignLead = async () => {
    setAssignBusy(true);
    setNotice('');
    try {
      await post(`/api/leads/${id}/assign`, { agentId: assignTo || null });
      setNotice('');
      load();
    } catch (e) {
      setNotice(e.message);
    } finally {
      setAssignBusy(false);
    }
  };

  const changeStage = async (stage) => {
    setNotice('');
    try {
      const res = await post(`/api/leads/${id}/stage`, { stage });
      setLead(res.lead || res || { ...lead, stage });
      load();
    } catch (e) {
      setNotice(e.message);
    }
  };

  const rescore = async () => {
    setScoring(true);
    setNotice('');
    try {
      const res = await post(`/api/leads/${id}/score`);
      setScore(res);
    } catch (e) {
      setNotice(e.message);
    } finally {
      setScoring(false);
    }
  };

  const aiScore = async () => {
    setAiScoring(true);
    setNotice('');
    try {
      const res = await post('/api/ai/score-lead', { leadId: id });
      setScore(res);
      setNotice('');
    } catch (e) {
      if (e.status === 503 || e.code === 'NO_API_KEY') {
        setNotice('AI scoring is not available — no AI key configured. ' +
          (user?.role === 'admin' ? 'Add one under Settings → AI Configuration.' : 'Ask your admin to add one under Settings.'));
      } else {
        setNotice(e.message);
      }
    } finally {
      setAiScoring(false);
    }
  };

  const addActivity = async (e) => {
    e.preventDefault();
    if (!actText.trim()) return;
    setActBusy(true);
    try {
      await post('/api/activities', { entityType: 'lead', entityId: id, kind: actKind, text: actText.trim() });
      setActText('');
      const a = await get(`/api/activities/lead/${id}`).catch(() => []);
      setActivities(asArray(a));
    } catch (err) {
      setNotice(err.message);
    } finally {
      setActBusy(false);
    }
  };

  const addFollowup = async (e) => {
    e.preventDefault();
    if (!fuTitle.trim() || !fuDate) return;
    setFuBusy(true);
    try {
      await post('/api/followups', { entityType: 'lead', entityId: id, title: fuTitle.trim(), dueDate: fuDate });
      setFuTitle(''); setFuDate('');
      const f = await get('/api/followups').catch(() => []);
      setFollowups(asArray(f).filter((x) => String(x.entityId) === String(id) && x.entityType === 'lead'));
    } catch (err) {
      setNotice(err.message);
    } finally {
      setFuBusy(false);
    }
  };

  const completeFollowup = async (f) => {
    try {
      await put(`/api/followups/${f.id}`, { done: true });
      setFollowups((prev) => prev.map((x) => (x.id === f.id ? { ...x, done: true } : x)));
    } catch (err) {
      setNotice(err.message);
    }
  };

  if (loading) return <Spinner />;
  if (error) return (<><BackLink to="/leads" label="Leads" /><Alert kind="error">{error}</Alert></>);
  if (!lead) return (<><BackLink to="/leads" label="Leads" /><Alert kind="error">Lead not found.</Alert></>);

  const ordered = LEAD_STAGES.includes(lead.stage) ? LEAD_STAGES : [...LEAD_STAGES, lead.stage];
  const curIdx = ordered.indexOf(lead.stage);

  return (
    <>
      <BackLink to="/leads" label="Leads" />
      <PageHeader
        title={lead.name}
        sub={`${lead.intent === 'sell' ? '🏷️ Sell' : lead.intent === 'rent' ? '🏠 Rent' : '🛒 Buy'}${lead.society ? ` · ${lead.society}` : ''} · ${lead.phone || 'no phone'} · Source: ${lead.source || '—'}`}
        actions={
          <>
            <WaButton phone={lead.whatsapp || lead.phone} name={lead.name} className="btn btn-secondary btn-sm" />
            <button className="btn btn-secondary" onClick={() => setShowEdit(true)}>Edit</button>
            <button className="btn btn-primary" onClick={() => setShowDeal(true)}>🤝 Create deal</button>
          </>
        }
      />

      {notice && <Alert kind={notice.startsWith('AI scoring') ? 'warn' : 'error'}>{notice}</Alert>}

      <div className="grid grid-2">
        <Card title="Lead information">
          <dl className="kv">
            <dt>Phone</dt><dd>{lead.phone || '—'}</dd>
            <dt>WhatsApp</dt><dd>{lead.whatsapp || lead.phone || '—'}</dd>
            <dt>Intent</dt><dd><Badge status={lead.intent || 'buy'} /></dd>
            <dt>Society</dt><dd>{lead.society || '—'}</dd>
            <dt>Interest</dt><dd>{lead.interest || '—'}</dd>
            <dt>Budget</dt><dd>{lead.budgetMin || lead.budgetMax ? `${lead.budgetMin ? pkr(lead.budgetMin) : '—'} – ${lead.budgetMax ? pkr(lead.budgetMax) : '—'}` : '—'}</dd>
            <dt>Source</dt><dd>{lead.source || '—'}</dd>
            <dt>Assigned to</dt><dd>{lead.assignedAgent?.name || 'Unassigned'}</dd>
            <dt>Notes</dt><dd>{lead.notes || '—'}</dd>
          </dl>
          {canAssign && (
            <>
              <hr className="divider" />
              <Field label="Assign to agent">
                <div style={{ display: 'flex', gap: 8 }}>
                  <select className="select" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} style={{ flex: 1 }}>
                    <option value="">Unassigned</option>
                    {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <button className="btn btn-primary btn-sm" onClick={assignLead} disabled={assignBusy}>
                    {assignBusy ? 'Assigning…' : 'Assign'}
                  </button>
                </div>
              </Field>
            </>
          )}
        </Card>

        <Card
          title="Lead score"
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-secondary btn-sm" onClick={rescore} disabled={scoring}>
                {scoring ? 'Scoring…' : 'Re-score'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={aiScore} disabled={aiScoring}>
                {aiScoring ? 'Asking AI…' : '✨ AI score'}
              </button>
            </div>
          }
        >
          {score || lead.score !== undefined || lead.aiScore !== undefined ? (
            <>
              <div className="score-wrap">
                <div className="score-num">{score?.score ?? score?.aiScore ?? lead.aiScore ?? lead.score ?? 0}</div>
                <div className="score-bar"><div className="score-fill" style={{ width: `${Math.min(100, score?.score ?? score?.aiScore ?? lead.aiScore ?? lead.score ?? 0)}%` }} /></div>
              </div>
              {(score?.breakdown || []).length > 0 && (
                <ul className="breakdown">
                  {(score.breakdown).map((b, i) => <li key={i}>{typeof b === 'string' ? b : b.text || JSON.stringify(b)}</li>)}
                </ul>
              )}
              {(score?.reason || score?.aiScoreReason || lead.aiScoreReason) && (
                <p className="muted mt-2">{score?.reason || score?.aiScoreReason || lead.aiScoreReason}</p>
              )}
              {score?.summary && <p className="muted mt-2">{score.summary}</p>}
            </>
          ) : (
            <EmptyState icon="📊" title="Not scored yet" hint="Run a score to prioritize this lead." />
          )}
        </Card>
      </div>

      <Card title="Pipeline stage" className="section-gap">
        <div className="stepper">
          {ordered.map((s, i) => (
            <div key={s} className={`step ${i < curIdx ? 'done' : ''} ${i === curIdx ? 'current' : ''}`}>
              <div className="step-dot">{i < curIdx ? '✓' : i + 1}</div>
              <div className="step-label">{prettyLabel(s)}</div>
              {i < ordered.length - 1 && <div className="step-line" />}
            </div>
          ))}
        </div>
        <div className="stage-actions">
          {ordered.filter((s) => s !== lead.stage).map((s) => (
            <button key={s} className="btn btn-secondary btn-sm" onClick={() => changeStage(s)}>
              → {prettyLabel(s)}
            </button>
          ))}
        </div>
      </Card>

      <div className="grid grid-2 section-gap">
        <Card title="Activity timeline">
          <form onSubmit={addActivity} style={{ marginBottom: 14 }}>
            <div className="form-row">
              <Field label="Kind">
                <select className="select" value={actKind} onChange={(e) => setActKind(e.target.value)}>
                  {ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{prettyLabel(k)}</option>)}
                </select>
              </Field>
              <div />
            </div>
            <Field label="Add activity">
              <textarea className="textarea" value={actText} onChange={(e) => setActText(e.target.value)} placeholder="Log a note, call outcome, or viewing…" />
            </Field>
            <button className="btn btn-primary btn-sm" disabled={actBusy || !actText.trim()}>
              {actBusy ? 'Adding…' : 'Add'}
            </button>
          </form>
          <hr className="divider" />
          {activities.length === 0 ? (
            <EmptyState icon="📝" title="No activity yet" hint="Log the first call or note above." />
          ) : (
            <div className="timeline">
              {activities.map((a, i) => (
                <div key={a.id || i} className="tl-item">
                  <div className="tl-dot">{KIND_ICONS[a.kind] || '📝'}</div>
                  <div className="tl-body">
                    <div><Badge status={a.kind} color={statusColor(a.kind)} /> <span style={{ marginLeft: 6 }}>{a.text}</span></div>
                    <div className="tl-meta">{a.actorName || ''} {fmtDateTime(a.createdAt || a.created_at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Follow-ups">
          <form onSubmit={addFollowup} style={{ marginBottom: 14 }}>
            <div className="form-row">
              <Field label="Title"><input className="input" value={fuTitle} onChange={(e) => setFuTitle(e.target.value)} placeholder="e.g. Call about DHA file" /></Field>
              <Field label="Due date"><input className="input" type="date" value={fuDate} onChange={(e) => setFuDate(e.target.value)} /></Field>
            </div>
            <button className="btn btn-primary btn-sm" disabled={fuBusy || !fuTitle.trim() || !fuDate}>
              {fuBusy ? 'Adding…' : 'Add follow-up'}
            </button>
          </form>
          <hr className="divider" />
          {followups.length === 0 ? (
            <EmptyState icon="⏰" title="No follow-ups" hint="Schedule one so this lead never goes cold." />
          ) : (
            <div className="timeline">
              {followups.map((f) => (
                <div key={f.id} className="tl-item">
                  <div className="tl-dot">{f.done ? '✅' : '⏰'}</div>
                  <div className="tl-body flex-between" style={{ width: '100%' }}>
                    <div>
                      <div style={{ textDecoration: f.done ? 'line-through' : 'none' }}>{f.title}</div>
                      <div className="tl-meta">Due {fmtDate(f.dueDate || f.due_date)}</div>
                    </div>
                    {!f.done && <button className="btn btn-ghost btn-sm" onClick={() => completeFollowup(f)}>Mark done</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {showEdit && (
        <Modal title="Edit lead" onClose={() => setShowEdit(false)} wide>
          <LeadForm initial={lead} agents={agents} canAssign={canAssign} onCancel={() => setShowEdit(false)} onSaved={() => { setShowEdit(false); load(); }} />
        </Modal>
      )}
      {showDeal && <DealModal lead={lead} onClose={() => setShowDeal(false)} />}
    </>
  );
}
