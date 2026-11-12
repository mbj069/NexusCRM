import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, asArray, asKeyCounts } from '../api';
import { useAuth } from '../auth';
import {
  PageHeader, Stat, Card, EmptyState, Spinner, Alert,
  pkr, prettyLabel,
} from '../components/ui';

/* ---------- Hand-rolled SVG charts (no chart library) ---------- */

/** Compact axis number: 1500 -> "1.5k", 2,500,000 -> "2.5M". */
function fmtCompact(n) {
  const v = Number(n) || 0;
  const trim = (x) => String(Math.round(x * 10) / 10).replace(/\.0$/, '');
  if (v >= 1_000_000) return `${trim(v / 1_000_000)}M`;
  if (v >= 1000) return `${trim(v / 1000)}k`;
  return String(v);
}

/** "2026-11" -> "Nov 26"; anything else is shown as-is. */
function fmtMonth(m) {
  const match = /^(\d{4})-(\d{2})/.exec(String(m || ''));
  if (!match) return String(m || '');
  const d = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}

/**
 * Grouped vertical bar chart for the monthly commission trend.
 * rows: [{ month, <seriesKey>: number, ... }], series: [{ key, label, color }].
 * money: true renders PKR on the axis; false renders plain counts.
 */
function GroupedBarChart({ rows, series, money }) {
  const W = 640;
  const H = 280;
  const padL = 64;
  const padR = 12;
  const padT = 18;
  const padB = 32;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const baseline = padT + plotH;
  const max = Math.max(1, ...rows.flatMap((r) => series.map((s) => Number(r[s.key]) || 0)));
  const groupW = rows.length ? plotW / rows.length : plotW;
  const barW = Math.max(6, Math.min(30, (groupW * 0.7) / series.length));
  const gap = 4;
  const ticks = [0, 0.5, 1].map((f) => ({ v: max * f, y: baseline - plotH * f }));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
        {ticks.map((t) => (
          <g key={t.v}>
            <line x1={padL} x2={W - padR} y1={t.y} y2={t.y} stroke="var(--slate-200)" strokeWidth="1" />
            <text x={padL - 8} y={t.y + 4} textAnchor="end" fontSize="11" fill="var(--slate-500)">
              {money ? `PKR ${fmtCompact(t.v)}` : fmtCompact(t.v)}
            </text>
          </g>
        ))}
        <line x1={padL} x2={W - padR} y1={baseline} y2={baseline} stroke="var(--slate-300)" strokeWidth="1" />
        {rows.map((r, i) => {
          const totalBarsW = series.length * barW + (series.length - 1) * gap;
          const startX = padL + i * groupW + (groupW - totalBarsW) / 2;
          return (
            <g key={r.month || i}>
              {series.map((s, j) => {
                const v = Number(r[s.key]) || 0;
                const h = (v / max) * plotH;
                return (
                  <rect
                    key={s.key}
                    x={startX + j * (barW + gap)}
                    y={baseline - h}
                    width={barW}
                    height={Math.max(h, v > 0 ? 2 : 0)}
                    rx={3}
                    fill={s.color}
                  >
                    <title>{`${fmtMonth(r.month)} — ${s.label}: ${money ? pkr(v) : v}`}</title>
                  </rect>
                );
              })}
              <text x={padL + i * groupW + groupW / 2} y={H - 10} textAnchor="middle" fontSize="11" fill="var(--slate-600)">
                {fmtMonth(r.month)}
              </text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 8 }}>
        {series.map((s) => (
          <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--slate-600)' }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: s.color, display: 'inline-block' }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Horizontal bar chart for stage/status breakdowns.
 * rows: [{ label, count }]. One indigo/blue/green bar per row, value at the end.
 */
function HBarChart({ rows, color }) {
  const rowH = 36;
  const H = Math.max(60, rows.length * rowH + 8);
  const labelW = 150;
  const barX = labelW + 8;
  const maxBarW = 640 - barX - 72;
  const max = Math.max(1, ...rows.map((r) => Number(r.count) || 0));

  return (
    <svg viewBox={`0 0 640 ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }} role="img">
      {rows.map((r, i) => {
        const y = 8 + i * rowH;
        const v = Number(r.count) || 0;
        const w = v > 0 ? Math.max(4, (v / max) * maxBarW) : 0;
        return (
          <g key={r.label}>
            <text x={labelW} y={y + 15} textAnchor="end" fontSize="12" fill="var(--slate-600)">
              {r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label}
            </text>
            <rect x={barX} y={y} width={w} height={20} rx={4} fill={color}>
              <title>{`${r.label}: ${v}`}</title>
            </rect>
            <text x={barX + w + 8} y={y + 15} fontSize="12" fontWeight="700" fill="var(--slate-800)">
              {v}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ---------- Dashboard ---------- */

export default function Dashboard() {
  const { isAdmin, isManager } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

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

  if (loading) return <Spinner />;
  if (error) return (<><PageHeader title="Dashboard" /><Alert kind="error">{error}</Alert></>);

  // The server only sends what this role may see. Every key below is
  // optional-chained with a fallback, so a missing key renders a zero
  // instead of crashing.
  const role = data?.role || (isAdmin ? 'admin' : isManager ? 'manager' : 'agent');
  const leadsByStage = asKeyCounts(data?.leadsByStage, 'stage');
  const dealsByStage = asKeyCounts(data?.dealsByStage, 'stage');
  const inventoryByStatus = asKeyCounts(data?.inventoryByStatus, 'status');
  const trend = asArray(data?.commissionTrend);
  const totalLeads = leadsByStage.reduce((s, r) => s + (Number(r.count) || 0), 0);
  const openDeals = dealsByStage
    .filter((r) => ['proposed', 'token_paid', 'in_progress'].includes(r.stage))
    .reduce((s, r) => s + (Number(r.count) || 0), 0);

  // Trend series depend on what the role received: money totals for admin
  // and agent (own share), plain counts for manager.
  const trendSeries = role === 'manager'
    ? [
      { key: 'countPending', label: 'Pending', color: '#d97706' },
      { key: 'countPaid', label: 'Paid', color: '#16a34a' },
    ]
    : role === 'agent'
      ? [
        { key: 'total', label: 'Total share', color: '#4f46e5' },
        { key: 'pending', label: 'Pending share', color: '#d97706' },
        { key: 'paid', label: 'Paid share', color: '#16a34a' },
      ]
      : [
        { key: 'total', label: 'Total', color: '#4f46e5' },
        { key: 'pending', label: 'Pending', color: '#d97706' },
        { key: 'paid', label: 'Paid', color: '#16a34a' },
      ];
  const trendMoney = role !== 'manager';
  const trendHasData = trend.length > 0
    && trend.some((r) => trendSeries.some((s) => (Number(r[s.key]) || 0) > 0));
  const trendTitle = role === 'manager'
    ? 'Monthly commission counts'
    : role === 'agent' ? 'My monthly share trend' : 'Monthly commission trend';

  const leadRows = leadsByStage.map((r) => ({ label: prettyLabel(r.stage), count: Number(r.count) || 0 }));
  const dealRows = dealsByStage.map((r) => ({ label: prettyLabel(r.stage), count: Number(r.count) || 0 }));
  const inventoryRows = inventoryByStatus.map((r) => ({ label: prettyLabel(r.status), count: Number(r.count) || 0 }));

  const sub = isAdmin ? 'Full picture of the business'
    : isManager ? 'Team overview — leads and deals'
      : 'My day — my leads, my deals, my share';

  return (
    <>
      <PageHeader
        title="Dashboard"
        sub={sub}
        actions={
          <button className="btn btn-secondary btn-sm" onClick={load}>↻ Refresh</button>
        }
      />

      {/* Quick Add — the five create shortcuts are open to every role,
          mirroring the list pages' unconditional Add buttons. Add expense
          is admin-only: managers are read-only on expenses and agents
          never reach the page. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/leads', { state: { openNew: true } })}>+ Add lead</button>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/inventory', { state: { openNew: true } })}>+ Add property</button>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/contacts', { state: { openNew: true } })}>+ Add contact</button>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/deals', { state: { openNew: true } })}>+ Add deal</button>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate('/followups', { state: { openNew: true } })}>+ Add follow-up</button>
        {isAdmin && (
          <button className="btn btn-secondary btn-sm" onClick={() => navigate('/expenses', { state: { openNew: true } })}>+ Add expense</button>
        )}
      </div>

      {/* Exactly four hero stats per role. */}
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        {isAdmin && (
          <>
            <Stat label="Total commission" value={pkr(data?.totalCommission ?? 0)} sub="Pending + paid, all deals" accent />
            <Stat label="Pending commission" value={pkr(data?.pendingCommission ?? 0)} sub="Owed to agents" />
            <Stat label="Commission paid" value={pkr(data?.paidCommission ?? 0)} sub="Paid out" />
            <Stat label="Active leads" value={data?.activeLeads ?? totalLeads} sub="Across all stages" />
          </>
        )}
        {isManager && !isAdmin && (
          <>
            <Stat label="Active leads" value={data?.activeLeads ?? totalLeads} sub="Across all stages" accent />
            <Stat label="Open deals" value={openDeals} sub="Proposed / token / in progress" />
            <Stat label="Commissions pending" value={data?.commissionCounts?.pending ?? 0} sub="Count only, no amounts" />
            <Stat label="Commissions paid" value={data?.commissionCounts?.paid ?? 0} sub="Count only, no amounts" />
          </>
        )}
        {role === 'agent' && (
          <>
            <Stat label="My total share" value={pkr(data?.myTotalShare ?? 0)} sub="Pending + paid, my deals" accent />
            <Stat label="My pending share" value={pkr(data?.myPendingShare ?? 0)} sub="Earned, not yet paid" />
            <Stat label="My paid share" value={pkr(data?.myPaidShare ?? 0)} sub="Paid out to me" />
            <Stat label="My active leads" value={data?.myActiveLeads ?? totalLeads} sub="Across all stages" />
          </>
        )}
      </div>

      <Card title={trendTitle} className="section-gap">
        {!trendHasData ? (
          <EmptyState icon="📊" title="No commission trend yet" hint="Monthly figures appear once commissions are recorded." />
        ) : (
          <GroupedBarChart rows={trend} series={trendSeries} money={trendMoney} />
        )}
      </Card>

      <div className="grid grid-2 section-gap">
        <Card title={role === 'agent' ? 'My leads by stage' : 'Leads by stage'}>
          {leadRows.length === 0 || leadRows.every((r) => r.count === 0) ? (
            <EmptyState icon="🎯" title="No leads yet" hint="Add your first lead to see the funnel." />
          ) : (
            <HBarChart rows={leadRows} color="#4f46e5" />
          )}
          <div className="mt-3"><Link to="/leads">View all leads →</Link></div>
        </Card>

        <Card title={role === 'agent' ? 'My deals by stage' : 'Deals by stage'}>
          {dealRows.length === 0 || dealRows.every((r) => r.count === 0) ? (
            <EmptyState icon="🤝" title="No deals yet" hint="Create a deal from a lead and a property." />
          ) : (
            <HBarChart rows={dealRows} color="#2563eb" />
          )}
          <div className="mt-3"><Link to="/deals">View all deals →</Link></div>
        </Card>
      </div>

      <Card title="Inventory by status" className="section-gap">
        {inventoryRows.length === 0 || inventoryRows.every((r) => r.count === 0) ? (
          <EmptyState icon="🏘️" title="No inventory yet" hint="List your first property to track availability." />
        ) : (
          <HBarChart rows={inventoryRows} color="#16a34a" />
        )}
        <div className="mt-3"><Link to="/inventory">View inventory →</Link></div>
      </Card>
    </>
  );
}
