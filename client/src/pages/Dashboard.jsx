import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, asArray, asKeyCounts } from '../api';
import { useAuth } from '../auth';
import {
  PageHeader, Stat, Card, Badge, EmptyState, Spinner, Alert,
  pkr, fmtDate, fmtDateTime, prettyLabel,
} from '../components/ui';

export default function Dashboard() {
  const { isAdmin, isManager } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [scanMsg, setScanMsg] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const d = await get('/api/dashboard');
      setData(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const scanOverdue = async () => {
    setScanning(true);
    setScanMsg('');
    try {
      const res = await post('/api/notifications/scan-overdue');
      const found = res && typeof res === 'object' ? (res.created ?? res.count ?? res.found ?? res.new ?? null) : null;
      setScanMsg(found !== null ? `Scan complete — ${found} overdue item(s) flagged.` : 'Scan complete.');
      load();
    } catch (e) {
      setScanMsg('Scan failed: ' + e.message);
    } finally {
      setScanning(false);
    }
  };

  if (loading) return <Spinner />;
  if (error) return (<><PageHeader title="Dashboard" /><Alert kind="error">{error}</Alert></>);

  // The server only sends what this role may see: revenue and commission
  // totals exist for admin only, agent performance carries money only for
  // admin, and recent activity is admin-only.
  const role = data?.role || 'agent';
  const revenue = data?.revenue || null;
  const commissionTotals = data?.commissionTotals || null;
  const leadsByStage = asKeyCounts(data?.leadsByStage, 'stage');
  const dealsByStage = asKeyCounts(data?.dealsByStage, 'stage');
  const inventoryByStatus = asKeyCounts(data?.inventoryByStatus, 'status');
  const overdue = asArray(data?.overdueInstallments);
  const agents = asArray(data?.agentPerformance);
  const recent = asArray(data?.recentActivity);
  const followups = data?.followups || {};
  const totalLeads = leadsByStage.reduce((s, r) => s + r.count, 0);
  const openDeals = dealsByStage.filter((r) => ['proposed', 'token_paid', 'in_progress'].includes(r.stage))
    .reduce((s, r) => s + r.count, 0);

  const sub = isAdmin ? "Full picture of the business"
    : isManager ? 'Team overview — leads, deals and follow-ups'
      : 'My day — my leads, my deals, my follow-ups';

  return (
    <>
      <PageHeader
        title="Dashboard"
        sub={sub}
        actions={
          <>
            <button className="btn btn-secondary btn-sm" onClick={load}>↻ Refresh</button>
            <button className="btn btn-primary btn-sm" onClick={scanOverdue} disabled={scanning}>
              {scanning ? 'Scanning…' : '🔍 Scan overdue'}
            </button>
          </>
        }
      />

      {scanMsg && <Alert kind={scanMsg.startsWith('Scan failed') ? 'error' : 'ok'}>{scanMsg}</Alert>}

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {isAdmin && (
          <>
            <Stat label="Collected" value={pkr(revenue?.collected)} sub="Payments received" accent />
            <Stat label="Expected" value={pkr(revenue?.expected)} sub="Still outstanding" />
            <Stat label="Overdue installments" value={overdue.length} sub={data?.overdueTotal ? `${pkr(data.overdueTotal)} outstanding` : 'Need follow-up'} />
            <Stat label="Active leads" value={totalLeads} sub="Across all stages" />
          </>
        )}
        {isManager && !isAdmin && (
          <>
            <Stat label="Active leads" value={totalLeads} sub="Across all stages" accent />
            <Stat label="Open deals" value={openDeals} sub="Proposed / token / in progress" />
            <Stat label="Overdue installments" value={overdue.length} sub="Need follow-up" />
            <Stat label="Follow-ups" value={(followups.overdue || 0) + (followups.dueToday || 0)} sub={`${followups.overdue || 0} overdue · ${followups.dueToday || 0} due today`} />
          </>
        )}
        {role === 'agent' && (
          <>
            <Stat label="My assigned leads" value={totalLeads} sub="Across all stages" accent />
            <Stat label="My open deals" value={openDeals} sub="Proposed / token / in progress" />
            <Stat label="My overdue installments" value={overdue.length} sub="Need follow-up" />
            <Stat label="My follow-ups" value={(followups.overdue || 0) + (followups.dueToday || 0)} sub={`${followups.overdue || 0} overdue · ${followups.dueToday || 0} due today`} />
          </>
        )}
      </div>

      {isAdmin && commissionTotals && (
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Stat label="Commission pending" value={pkr(commissionTotals.pending)} sub="Owed to agents" />
          <Stat label="Commission paid" value={pkr(commissionTotals.paid)} sub="Paid out" />
          <Stat label="Commission total" value={pkr((commissionTotals.pending || 0) + (commissionTotals.paid || 0))} sub="All deals" />
          <Stat label="Overdue total" value={pkr(data?.overdueTotal)} sub={`${overdue.length} overdue installment(s)`} />
        </div>
      )}

      {role === 'agent' && data?.myCommissions && (
        <div className="grid grid-4" style={{ marginBottom: 16 }}>
          <Stat label="My commission pending" value={pkr(data.myCommissions.pending)} sub="Earned, not yet paid" />
          <Stat label="My commission paid" value={pkr(data.myCommissions.paid)} sub="Paid out to me" />
          <Stat label="My open deals value" value={pkr(data.myDeals?.openValue)} sub={`${data.myDeals?.open || 0} open deal(s)`} />
          <Stat label="My overdue" value={overdue.length} sub="Installments to chase" />
        </div>
      )}

      <div className="grid grid-2">
        <Card title={role === 'agent' ? 'My leads funnel' : 'Leads funnel'}>
          {leadsByStage.length === 0 ? (
            <EmptyState icon="🎯" title="No leads yet" hint="Add your first lead to see the funnel." />
          ) : (
            <div className="timeline">
              {leadsByStage.map((r) => (
                <div key={r.stage} className="tl-item">
                  <div className="tl-body flex-between" style={{ width: '100%' }}>
                    <Badge status={r.stage} />
                    <strong>{r.count}</strong>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3"><Link to="/leads">View all leads →</Link></div>
        </Card>

        <Card title={role === 'agent' ? 'My deals by stage' : 'Deals by stage'}>
          {dealsByStage.length === 0 ? (
            <EmptyState icon="🤝" title="No deals yet" hint="Create a deal from a lead and a property." />
          ) : (
            <div className="timeline">
              {dealsByStage.map((r) => (
                <div key={r.stage} className="tl-item">
                  <div className="tl-body flex-between" style={{ width: '100%' }}>
                    <Badge status={r.stage} />
                    <strong>{r.count}</strong>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3"><Link to="/deals">View all deals →</Link></div>
        </Card>
      </div>

      <div className="grid grid-2 section-gap">
        <Card title="Inventory by status">
          {inventoryByStatus.length === 0 ? (
            <EmptyState icon="🏘️" title="No inventory yet" hint="List your first property to track availability." />
          ) : (
            <div className="timeline">
              {inventoryByStatus.map((r) => (
                <div key={r.status} className="tl-item">
                  <div className="tl-body flex-between" style={{ width: '100%' }}>
                    <Badge status={r.status} />
                    <strong>{r.count}</strong>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3"><Link to="/inventory">View inventory →</Link></div>
        </Card>

        {isAdmin && (
          <Card title="Recent activity">
            {recent.length === 0 ? (
              <EmptyState icon="📝" title="No recent activity" />
            ) : (
              <div className="timeline">
                {recent.slice(0, 12).map((a, i) => (
                  <div key={a.id || i} className="tl-item">
                    <div className="tl-dot">📝</div>
                    <div className="tl-body">
                      <div>{a.details || prettyLabel(a.action)}</div>
                      <div className="tl-meta">
                        {a.actorName || ''}{a.actorName ? ' · ' : ''}{fmtDateTime(a.timestamp || a.createdAt || a.created_at)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}
        {!isAdmin && (
          <Card title="Follow-ups">
            <div className="timeline">
              <div className="tl-item">
                <div className="tl-body flex-between" style={{ width: '100%' }}>
                  <span>Overdue</span><strong>{followups.overdue || 0}</strong>
                </div>
              </div>
              <div className="tl-item">
                <div className="tl-body flex-between" style={{ width: '100%' }}>
                  <span>Due today</span><strong>{followups.dueToday || 0}</strong>
                </div>
              </div>
            </div>
            <div className="mt-3"><Link to="/followups">View follow-ups →</Link></div>
          </Card>
        )}
      </div>

      <Card title={role === 'agent' ? 'My overdue installments' : 'Overdue installments'} className="section-gap">
        {overdue.length === 0 ? (
          <EmptyState icon="✅" title="Nothing overdue" hint="All installments are on track." />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Contact</th><th>Property</th><th className="num">Outstanding</th>
                  <th>Due date</th><th className="num">Days overdue</th><th></th>
                </tr>
              </thead>
              <tbody>
                {overdue.map((o, i) => (
                  <tr key={o.scheduleId || o.id || i} className="overdue-row">
                    <td>{o.contact?.name || '—'}<div className="muted">{o.contact?.phone || ''}</div></td>
                    <td>
                      {o.propertyCode || '—'}
                      <div className="muted">{prettyLabel(o.kind)}</div>
                    </td>
                    <td className="num"><strong>{pkr(o.outstanding ?? o.amount)}</strong></td>
                    <td>{fmtDate(o.dueDate || o.due_date)}</td>
                    <td className="num"><Badge status="overdue" /> {o.daysOverdue ?? ''}</td>
                    <td>{o.dealId ? <Link to={`/deals/${o.dealId}`} className="btn btn-ghost btn-sm">Deal →</Link> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {role !== 'agent' && (
        <Card title="Agent performance" className="section-gap">
          {agents.length === 0 ? (
            <EmptyState icon="👥" title="No data yet" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Agent</th><th className="num">Leads assigned</th><th className="num">Open deals</th>
                    <th className="num">Closed</th>
                    {isAdmin && <><th className="num">Revenue</th><th className="num">Commission</th></>}
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a, i) => (
                    <tr key={a.agentId || a.id || i}>
                      <td>{a.name || a.agentName || a.username || '—'}</td>
                      <td className="num">{a.leadsAssigned ?? 0}</td>
                      <td className="num">{a.openDeals ?? 0}</td>
                      <td className="num">{a.dealsClosed ?? a.deals ?? 0}</td>
                      {isAdmin && (
                        <>
                          <td className="num">{pkr(a.revenue)}</td>
                          <td className="num">{pkr(a.commissionEarned ?? a.commission)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
