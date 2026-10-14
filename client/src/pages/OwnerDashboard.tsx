import { useState } from 'react';
import { Link } from 'react-router-dom';
import { money, shortDate } from '../api';
import { useApi } from '../hooks';
import { LevelBadge, Loading, PageHead, RevenueChart, Stat, channelName } from '../components/ui';

interface Dash {
  revenue: number; grossProfit: number; commission: number; expenses: number; netProfit: number; jerseys: number; orders: number;
  byChannel: { channel: string; revenue: number; jerseys: number }[];
  daily: { day: string; revenue: number; profit: number }[];
  pendingApprovals: number; pendingJerseyUpdates: number; pendingStockRequests: number; lowStock: { id: number; team: string; kit: string; size: string; stock: number }[];
  commissionOwed: number; cashWithTeam: number; jerseysWithTeam: number;
  team: { id: number; name: string; level: number; periodJerseys: number; madeForYou: number; warningDeadline: string | null; pendingRemoval: boolean; onShiftSince: string | null }[];
}

const CHART_KEY = 'y11hq-chart-mode';
const savedChart = (): 'bars' | 'line' => {
  try { return localStorage.getItem(CHART_KEY) === 'line' ? 'line' : 'bars'; } catch { return 'bars'; }
};

const RANGES = [['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All time']] as const;

export function OwnerDashboard() {
  const [range, setRange] = useState<(typeof RANGES)[number][0]>('month');
  const { data: d, error } = useApi<Dash>(`/dashboard/owner?range=${range}`);
  const [chart, setChart] = useState<'bars' | 'line'>(savedChart);
  const pickChart = (m: 'bars' | 'line') => {
    setChart(m);
    try { localStorage.setItem(CHART_KEY, m); } catch { /* private window: just don't remember */ }
  };

  // "2 sales, 1 jersey update and 1 stock request are waiting for your approval."
  const waiting = d ? ([[d.pendingApprovals, 'sale'], [d.pendingJerseyUpdates, 'jersey update'], [d.pendingStockRequests, 'stock request']] as const)
    .filter(([n]) => n > 0).map(([n, what]) => `${n} ${what}${n > 1 ? 's' : ''}`) : [];
  const waitingText = waiting.length > 1 ? `${waiting.slice(0, -1).join(', ')} and ${waiting[waiting.length - 1]}` : waiting[0];
  const waitingTotal = d ? d.pendingApprovals + d.pendingJerseyUpdates + d.pendingStockRequests : 0;

  return (
    <>
      <PageHead title="Dashboard" sub="Everything about Y11, in one place.">
        <div className="segmented">
          {RANGES.map(([k, label]) => <button key={k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{label}</button>)}
        </div>
      </PageHead>
      {!d ? <Loading error={error} /> : (
        <div className="stack">
          {waitingTotal > 0 && (
            <div className="alert warn">
              {waitingText} {waitingTotal > 1 ? 'are' : 'is'} waiting for your approval. <Link to="/approvals">Review now</Link>
            </div>
          )}
          {d.team.filter((a) => a.pendingRemoval).map((a) => (
            <div key={a.id} className="alert bad">{a.name} missed the warning deadline. <Link to="/team">Decide in Team</Link></div>
          ))}

          <div className="grid g4">
            <div className="span2"><Stat hero label="Revenue" value={money(d.revenue)} note={`${d.orders} orders · ${d.jerseys} jerseys`} /></div>
            <Stat label="Real profit" value={money(d.netProfit)} note={`${money(d.grossProfit)} − ${money(d.commission)} team pay − ${money(d.expenses)} expenses`} />
            <Stat label="Jerseys sold" value={d.jerseys} note={`${d.orders} orders`} />
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Last 30 days</h2>
              <div className="segmented" role="group" aria-label="Chart type">
                <button className={chart === 'bars' ? 'on' : ''} onClick={() => pickChart('bars')}>Bars</button>
                <button className={chart === 'line' ? 'on' : ''} onClick={() => pickChart('line')}>Line</button>
              </div>
            </div>
            <RevenueChart days={d.daily} mode={chart} />
          </div>

          <div className="grid g3">
            <div className="panel">
              <h2>How it sold</h2>
              <table style={{ marginTop: 8 }}>
                <tbody>
                  {d.byChannel.length === 0 && <tr><td className="muted">No sales in this range.</td></tr>}
                  {d.byChannel.sort((a, b) => b.revenue - a.revenue).map((c) => (
                    <tr key={c.channel}><td>{channelName(c.channel)}</td><td className="num">{c.jerseys} jersey{c.jerseys === 1 ? "" : "s"}</td><td className="num"><strong>{money(c.revenue)}</strong></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="panel">
              <h2>With your team</h2>
              <table style={{ marginTop: 8 }}>
                <tbody>
                  <tr><td>Commission you owe</td><td className="num"><strong>{money(d.commissionOwed)}</strong></td></tr>
                  <tr><td>Cash they're holding</td><td className="num"><strong>{money(d.cashWithTeam)}</strong></td></tr>
                  <tr><td>Jerseys in their hands</td><td className="num"><strong>{d.jerseysWithTeam}</strong></td></tr>
                </tbody>
              </table>
            </div>
            <div className="panel">
              <div className="panel-head"><h2>Low stock</h2><Link className="small" to="/inventory">Inventory</Link></div>
              {d.lowStock.length === 0 ? <p className="muted">Nothing running low.</p> : (
                <table><tbody>
                  {d.lowStock.map((v) => (
                    <tr key={v.id}><td>{v.team} {v.kit} <span className="muted">{v.size}</span></td><td className="num"><span className={`badge ${v.stock === 0 ? 'bad' : 'warn'}`}>{v.stock} left</span></td></tr>
                  ))}
                </tbody></table>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head"><h2>Team this period</h2><Link className="small" to="/team">Manage team</Link></div>
            {d.team.length === 0 ? <p className="muted">No associates yet. Add one in Team.</p> : (
              <table>
                <thead><tr><th>Associate</th><th>Level</th><th className="num">Jerseys this period</th><th className="num">Made for you (all time)</th><th>Status</th></tr></thead>
                <tbody>
                  {d.team.map((a) => (
                    <tr key={a.id}>
                      <td>{a.name}</td><td><LevelBadge level={a.level} /></td><td className="num">{a.periodJerseys}</td><td className="num">{money(a.madeForYou)}</td>
                      <td>
                        {a.pendingRemoval ? <span className="badge bad">Missed deadline</span>
                          : a.warningDeadline ? <span className="badge warn">Warning until {shortDate(a.warningDeadline)}</span>
                          : a.onShiftSince ? <span className="badge good">On shift</span> : <span className="muted small">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </>
  );
}
