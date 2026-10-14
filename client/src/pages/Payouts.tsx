import { Fragment, useState } from 'react';
import { api, money, shortDate, dateTime } from '../api';
import { useApi } from '../hooks';
import { Loading, PageHead, Stat } from '../components/ui';

interface Owed { id: number; name: string; active: boolean; owed: number; commission: number; bonuses: number; items: number; oldest: string }
interface Payout { id: number; associateId: number; associateName: string; amount: number; method: string; note: string | null; paidAt: string; items: number }
interface Line { id: number; kind: string; level: number; amount: number; note: string | null; earnedAt: string; saleId: number | null; customerName: string | null; saleJerseys: number | null }

const KIND: Record<string, string> = { commission: 'Commission', milestone: 'Milestone bonus' };
const lineText = (l: Line) =>
  l.kind === 'commission' ? `Set of 3 at Level ${l.level}${l.customerName ? ` (completed on sale to ${l.customerName})` : ''}` : l.note ?? KIND[l.kind];

function Lines({ lines }: { lines: Line[] }) {
  if (!lines.length) return <p className="muted">Nothing here.</p>;
  return (
    <table>
      <thead><tr><th>Date</th><th>Type</th><th>Details</th><th className="num">Amount</th></tr></thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id}>
            <td className="small">{shortDate(l.earnedAt)}</td>
            <td><span className={`badge ${l.kind === 'commission' ? '' : 'good'}`}>{KIND[l.kind] ?? l.kind}</span></td>
            <td>{lineText(l)}</td>
            <td className="num">{money(l.amount)}</td>
          </tr>
        ))}
        <tr><td colSpan={3}><strong>Total</strong></td><td className="num"><strong>{money(lines.reduce((n, l) => n + l.amount, 0))}</strong></td></tr>
      </tbody>
    </table>
  );
}

/** One payout's commission statement */
export function Statement({ id }: { id: number }) {
  const { data } = useApi<Payout & { lines: Line[] }>(`/payouts/${id}`);
  if (!data) return <p className="muted small">Loading…</p>;
  return (
    <div className="panel" style={{ background: '#fbfaf7' }}>
      <div className="panel-head">
        <div><h3>Commission statement #{data.id}</h3><div className="small muted">{data.associateName} · paid {dateTime(data.paidAt)} by {data.method === 'etransfer' ? 'e-Transfer' : data.method}{data.note && ` · ${data.note}`}</div></div>
        <button className="secondary small" onClick={() => window.print()}>Print</button>
      </div>
      <Lines lines={data.lines} />
    </div>
  );
}

function History({ payouts }: { payouts: Payout[] }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!payouts.length) return <p className="muted">No payouts yet.</p>;
  return (
    <table>
      <thead><tr><th>Paid</th><th>Associate</th><th>Method</th><th className="num">Lines</th><th className="num">Amount</th><th /></tr></thead>
      <tbody>
        {payouts.map((p) => (
          <Fragment key={p.id}>
            <tr>
              <td>{shortDate(p.paidAt)}</td><td>{p.associateName}</td>
              <td className="small">{p.method === 'etransfer' ? 'e-Transfer' : p.method}{p.note && <div className="muted">{p.note}</div>}</td>
              <td className="num">{p.items}</td><td className="num"><strong>{money(p.amount)}</strong></td>
              <td className="num"><button className="link small" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Hide' : 'Statement'}</button></td>
            </tr>
            {open === p.id && <tr><td colSpan={6}><Statement id={p.id} /></td></tr>}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function OwedRow({ o, onPaid }: { o: Owed; onPaid: () => void }) {
  const [show, setShow] = useState(false);
  const lines = useApi<Line[]>(show ? `/earnings/unpaid?associateId=${o.id}` : null);
  const [err, setErr] = useState<string | null>(null);
  const [method, setMethod] = useState('etransfer');
  const pay = async () => {
    if (!window.confirm(`Mark ${money(o.owed)} as paid to ${o.name} by ${method === 'etransfer' ? 'e-Transfer' : method}?`)) return;
    try {
      await api.post('/payouts', { associateId: o.id, method });
      onPaid();
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <>
      <tr>
        <td><strong>{o.name}</strong>{!o.active && <span className="muted small"> (removed)</span>}<div className="small muted">owed since {shortDate(o.oldest)}</div></td>
        <td className="num">{money(o.commission)}</td><td className="num">{money(o.bonuses)}</td>
        <td className="num"><strong>{money(o.owed)}</strong></td>
        <td className="num"><div className="actions" style={{ justifyContent: 'flex-end' }}>
          <button className="link small" onClick={() => setShow((s) => !s)}>{show ? 'Hide' : 'Details'}</button>
          <select value={method} onChange={(e) => setMethod(e.target.value)} style={{ width: 'auto', padding: '5px 8px' }}>
            <option value="etransfer">e-Transfer</option><option value="cash">Cash</option><option value="other">Other</option>
          </select>
          <button className="good small" onClick={pay}>Mark as paid</button>
        </div>{err && <div className="error small">{err}</div>}</td>
      </tr>
      {show && <tr><td colSpan={5}>{lines.data ? <Lines lines={lines.data} /> : <span className="muted small">Loading…</span>}</td></tr>}
    </>
  );
}

export function Payouts() {
  const owed = useApi<Owed[]>('/payouts/summary');
  const history = useApi<Payout[]>('/payouts');
  const total = (owed.data ?? []).reduce((n, o) => n + o.owed, 0);
  const reload = () => { owed.reload(); history.reload(); };
  return (
    <>
      <PageHead title="Payouts" sub="Pay your team after you send the e-Transfer. Each payout creates a statement they can see." />
      <div className="grid g3">
        <Stat hero label="You owe right now" value={money(total)} note={`${owed.data?.length ?? 0} associate(s)`} />
        <Stat label="Paid out this month" value={money((history.data ?? []).filter((p) => new Date(p.paidAt).getMonth() === new Date().getMonth()).reduce((n, p) => n + p.amount, 0))} />
        <Stat label="Payouts made" value={history.data?.length ?? 0} />
      </div>
      <div className="panel">
        <h2>Owed</h2>
        {!owed.data ? <Loading error={owed.error} /> : owed.data.length === 0 ? <p className="muted">Everyone is paid up.</p> : (
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Associate</th><th className="num">Commission</th><th className="num">Bonuses</th><th className="num">Total</th><th /></tr></thead>
            <tbody>{owed.data.map((o) => <OwedRow key={o.id} o={o} onPaid={reload} />)}</tbody>
          </table>
        )}
      </div>
      <div className="panel">
        <h2>History</h2>
        <div style={{ marginTop: 8 }}>{history.data ? <History payouts={history.data} /> : <Loading error={history.error} />}</div>
      </div>
    </>
  );
}

export function MyPayouts() {
  const unpaid = useApi<Line[]>('/earnings/unpaid');
  const history = useApi<Payout[]>('/payouts');
  const owed = (unpaid.data ?? []).reduce((n, l) => n + l.amount, 0);
  return (
    <>
      <PageHead title="My Payouts" sub="What you've earned, what's coming, and a statement for every payment." />
      <div className="grid g2">
        <Stat hero label="Coming in your next payout" value={money(owed)} note={`${unpaid.data?.length ?? 0} item(s)`} />
        <Stat label="Paid to you so far" value={money((history.data ?? []).reduce((n, p) => n + p.amount, 0))} note={`${history.data?.length ?? 0} payout(s)`} />
      </div>
      <div className="panel">
        <h2>Not paid yet</h2>
        <div style={{ marginTop: 8 }}>{unpaid.data ? <Lines lines={unpaid.data} /> : <Loading error={unpaid.error} />}</div>
      </div>
      <div className="panel">
        <h2>Past payouts</h2>
        <div style={{ marginTop: 8 }}>{history.data ? <History payouts={history.data} /> : <Loading error={history.error} />}</div>
      </div>
    </>
  );
}
