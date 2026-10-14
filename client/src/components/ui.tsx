import { ReactNode } from 'react';
import { money, shortDate, dateTime } from '../api';

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children && <div className="actions">{children}</div>}
    </div>
  );
}

export function Stat({ label, value, note, hero }: { label: string; value: ReactNode; note?: ReactNode; hero?: boolean }) {
  return (
    <div className={`stat${hero ? ' hero' : ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

export const LevelBadge = ({ level }: { level: number }) => <span className={`badge l${level}`}>Level {level}</span>;

export function Progress({ value, max }: { value: number; max: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <div style={{ width: `${Math.min(100, (value / max) * 100)}%` }} />
    </div>
  );
}

export function Loading({ error }: { error?: string | null }) {
  return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
}

/**
 * Revenue and profit for the last 30 days. Hand-drawn SVG, no chart library.
 * "bars": one bar per day (profit inside revenue). "line": a line per series, like a stock chart.
 */
export function RevenueChart({ days, mode = 'bars' }: { days: { day: string; revenue: number; profit: number }[]; mode?: 'bars' | 'line' }) {
  const W = 760, H = 220, padL = 44, padB = 26, padT = 10;
  const max = Math.max(50, ...days.map((d) => d.revenue));
  const step = max > 400 ? 200 : max > 200 ? 100 : 50;
  const top = Math.ceil(max / step) * step;
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / top);
  const bw = (W - padL) / days.length;
  const cx = (i: number) => padL + i * bw + bw / 2;
  const ticks = Array.from({ length: top / step + 1 }, (_, i) => i * step);
  const tip = (d: { day: string; revenue: number; profit: number }) =>
    `${shortDate(d.day + 'T12:00')}: ${money(d.revenue)} revenue, ${money(d.profit)} profit`;
  const path = (key: 'revenue' | 'profit') => days.map((d, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join(' ');
  const REVENUE = '#b8b2a4', PROFIT = '#141414';

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Revenue and profit, last 30 days, ${mode === 'line' ? 'line' : 'bar'} chart`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="#e4e1d9" />
            <text x={padL - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#6b6a66">${t}</text>
          </g>
        ))}
        {days.map((d, i) => i % 5 === 0 && (
          <text key={`x${d.day}`} x={cx(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="#6b6a66">{shortDate(d.day + 'T12:00')}</text>
        ))}

        {mode === 'bars' ? days.map((d, i) => {
          const x = padL + i * bw + bw * 0.18, w = bw * 0.64;
          return (
            <g key={d.day}>
              <title>{tip(d)}</title>
              <rect x={x} y={y(d.revenue)} width={w} height={y(0) - y(d.revenue)} rx="2" fill={REVENUE} fillOpacity="0.75" />
              <rect x={x} y={y(d.profit)} width={w} height={y(0) - y(d.profit)} rx="2" fill={PROFIT} />
            </g>
          );
        }) : (
          <g>
            {/* Shaded area under revenue, then the two lines */}
            <path d={`${path('revenue')} L${cx(days.length - 1)} ${y(0)} L${cx(0)} ${y(0)} Z`} fill={REVENUE} fillOpacity="0.22" />
            <path d={path('revenue')} fill="none" stroke={REVENUE} strokeWidth="2.25" strokeLinejoin="round" />
            <path d={path('profit')} fill="none" stroke={PROFIT} strokeWidth="2.25" strokeLinejoin="round" />
            {days.map((d, i) => (
              <g key={d.day} className="chart-point">
                <title>{tip(d)}</title>
                {/* Wide invisible hit area so hovering anywhere on the day shows the numbers */}
                <rect x={padL + i * bw} y={padT} width={bw} height={y(0) - padT} fill="transparent" />
                <circle cx={cx(i)} cy={y(d.revenue)} r="3" fill="#fff" stroke={REVENUE} strokeWidth="1.5" />
                <circle cx={cx(i)} cy={y(d.profit)} r="3" fill="#fff" stroke={PROFIT} strokeWidth="1.5" />
              </g>
            ))}
          </g>
        )}
      </svg>
      <div className="actions small muted" style={{ marginTop: 8 }}>
        <span><span className="legend-key" style={{ background: REVENUE }} /> Revenue</span>
        <span><span className="legend-key" style={{ background: PROFIT }} /> Profit (before commission)</span>
        <span>Hover a day to see its numbers.</span>
      </div>
    </div>
  );
}

const CHANNEL: Record<string, string> = { in_hand: 'In hand', etransfer: 'e-Transfer order', website: 'Website', owner: 'Sold by you' };
export const channelName = (c: string) => CHANNEL[c] ?? c;

export interface SaleRow {
  id: number; soldBy: string; channel: string; paymentMethod: string; customerName: string; customerEmail: string | null;
  status: 'pending' | 'approved' | 'rejected'; createdAt: string; decidedAt: string | null; rejectReason: string | null;
  notes: string | null; jerseyCount: number; squadDeal: boolean; revenue: number; shipping: number; cost?: number; profit?: number;
  whatsappDiscount: number;
  items: { team: string; kit: string; size: string; quantity: number; nameNumber: boolean; customText: string | null; patch: boolean }[];
}

export const itemsText = (s: SaleRow) =>
  s.items.map((i) => `${i.quantity > 1 ? i.quantity + '× ' : ''}${i.team} ${i.kit} (${i.size})${i.nameNumber ? ` + ${i.customText || 'name & number'}` : ''}${i.patch ? ' + patch' : ''}`).join(', ');

export function StatusBadge({ s }: { s: SaleRow }) {
  if (s.status === 'approved') return <span className="badge good">Approved</span>;
  if (s.status === 'rejected') return <span className="badge bad" title={s.rejectReason ?? ''}>Rejected</span>;
  return <span className="badge warn">Pending</span>;
}

export function SalesTable({ sales, showSeller = true, showProfit = false, actions }: {
  sales: SaleRow[]; showSeller?: boolean; showProfit?: boolean; actions?: (s: SaleRow) => ReactNode;
}) {
  if (!sales.length) return <p className="empty">No sales yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Date</th>{showSeller && <th>Sold by</th>}<th>Customer</th><th>Jerseys</th><th>How</th>
            <th className="num">Paid</th>{showProfit && <th className="num">Profit</th>}<th>Status</th>{actions && <th />}
          </tr>
        </thead>
        <tbody>
          {sales.map((s) => (
            <tr key={s.id}>
              <td className="small">{dateTime(s.createdAt)}</td>
              {showSeller && <td>{s.soldBy}</td>}
              <td>{s.customerName}<div className="small muted">{s.customerEmail}</div></td>
              <td>
                {itemsText(s)}
                {(s.squadDeal || s.whatsappDiscount > 0) && (
                  <div className="actions" style={{ gap: 4 }}>
                    {s.squadDeal && <span className="badge good">Squad Deal</span>}
                    {s.whatsappDiscount > 0 && <span className="badge good">WhatsApp −{money(s.whatsappDiscount)}</span>}
                  </div>
                )}
              </td>
              <td className="small">{channelName(s.channel)}<div className="muted">{s.paymentMethod === 'cash' ? 'Cash' : s.paymentMethod === 'stripe' ? 'Card' : 'e-Transfer'}</div></td>
              <td className="num">{money(s.revenue + s.shipping)}{s.shipping > 0 && <div className="small muted">incl. {money(s.shipping)} ship</div>}</td>
              {showProfit && <td className="num">{s.profit !== undefined ? money(s.profit) : ''}</td>}
              <td><StatusBadge s={s} />{s.status === 'rejected' && s.rejectReason && <div className="small muted">{s.rejectReason}</div>}</td>
              {actions && <td>{actions(s)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
