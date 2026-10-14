import { useState } from 'react';
import { api, money, dateTime, shortDate } from '../api';
import { useApi } from '../hooks';
import { Loading, PageHead, SaleRow, channelName, itemsText } from '../components/ui';
import { KIND_LABEL } from './Stock';

interface JerseyUpdate {
  id: number; kind: 'returned' | 'lost' | 'damaged'; quantity: number; note: string | null; createdAt: string;
  associateName: string; team: string; kit: string; size: string; cost: number;
}
interface StockRequest {
  id: number; associateName: string; note: string | null; createdAt: string;
  items: { id: number; team: string; kit: string; size: string; quantity: number; stock: number }[];
}

/** One stock request. You can lower each amount before handing the jerseys over. */
function StockRequestCard({ r, dueBy, busy, onApprove, onDecline }: {
  r: StockRequest; dueBy: string | null; busy: boolean;
  onApprove: (items: { itemId: number; quantity: number }[]) => void; onDecline: () => void;
}) {
  const [amounts, setAmounts] = useState<Record<number, number>>(() => Object.fromEntries(r.items.map((i) => [i.id, Math.min(i.quantity, i.stock)])));
  return (
    <div className="panel">
      <div className="panel-head">
        <h2>{r.associateName}</h2>
        <span className="badge warn">{r.items.reduce((n, i) => n + i.quantity, 0)} jerseys</span>
      </div>
      <table>
        <thead><tr><th>Jersey</th><th className="num">Asked</th><th className="num">Hand over</th></tr></thead>
        <tbody>
          {r.items.map((i) => (
            <tr key={i.id}>
              <td>{i.team} {i.kit} <span className="muted">{i.size}</span><div className="small muted">{i.stock} in main stock</div></td>
              <td className="num">{i.quantity}</td>
              <td className="num">
                <input type="number" min={0} max={i.quantity} value={amounts[i.id]} style={{ width: 72 }} aria-label={`Hand over ${i.team} ${i.kit} ${i.size}`}
                  onChange={(e) => setAmounts((a) => ({ ...a, [i.id]: Math.max(0, Math.min(i.quantity, Number(e.target.value))) }))} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.note && <p><span className="muted">Note:</span> {r.note}</p>}
      <p className="small muted">Asked {dateTime(r.createdAt)}. You can lower the amounts.{dueBy && ` Due back ${dueBy}, like jerseys you give out in Inventory.`}</p>
      <div className="actions" style={{ marginTop: 14 }}>
        <button className="good" disabled={busy} onClick={() => onApprove(r.items.map((i) => ({ itemId: i.id, quantity: amounts[i.id] })))}>Approve &amp; hand over</button>
        <button className="bad" disabled={busy} onClick={onDecline}>Decline</button>
      </div>
    </div>
  );
}

export function Approvals() {
  const sales = useApi<SaleRow[]>('/sales?status=pending');
  const updates = useApi<JerseyUpdate[]>('/jersey-updates?status=pending');
  const requests = useApi<StockRequest[]>('/stock-requests?status=pending');
  const settings = useApi<{ inHandDays: number }>('/settings');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setMsg(null);
    try {
      await action();
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(null);
    }
  }

  async function decide(s: SaleRow, approve: boolean) {
    let reason = '';
    if (!approve) {
      reason = window.prompt(`Why are you rejecting ${s.customerName}'s sale?`, 'No matching e-Transfer found') ?? '';
      if (!reason) return;
    }
    await run(`sale${s.id}`, async () => {
      await api.post(`/sales/${s.id}/${approve ? 'approve' : 'reject'}`, approve ? {} : { reason });
      await sales.reload();
    });
  }

  const decideUpdate = (u: JerseyUpdate, confirm: boolean) => run(`update${u.id}`, async () => {
    await api.post(`/jersey-updates/${u.id}/${confirm ? 'confirm' : 'decline'}`);
    await updates.reload();
  });

  const approveRequest = (r: StockRequest, items: { itemId: number; quantity: number }[]) => run(`request${r.id}`, async () => {
    await api.post(`/stock-requests/${r.id}/approve`, { items });
    await requests.reload();
  });
  const declineRequest = (r: StockRequest) => run(`request${r.id}`, async () => {
    await api.post(`/stock-requests/${r.id}/decline`);
    await requests.reload();
  });

  const dueBy = settings.data ? shortDate(new Date(Date.now() + settings.data.inHandDays * 864e5)) : null;
  const loaded = sales.data && updates.data && requests.data;
  return (
    <>
      <PageHead title="Pending Approvals" sub="Check each one against your Interac emails (or the cash you were handed), then approve it. Only approved sales count for stock, levels and commission." />
      {msg && <div className="alert bad">{msg}</div>}
      {!loaded ? <Loading error={sales.error ?? updates.error ?? requests.error} />
        : sales.data!.length + updates.data!.length + requests.data!.length === 0 ? <div className="panel empty">All caught up. Nothing to approve.</div> : (
        <>
          <h2 className="section-title">Sales</h2>
          {sales.data!.length === 0 ? <p className="muted">No sales waiting.</p> : (
            <div className="grid g2">
              {sales.data!.map((s) => (
                <div className="panel" key={s.id}>
                  <div className="panel-head">
                    <h2>{money(s.revenue + s.shipping)}</h2>
                    <span className="badge warn">{s.paymentMethod === 'cash' ? 'Cash' : 'e-Transfer'}</span>
                  </div>
                  <table><tbody>
                    <tr><td className="muted">Sold by</td><td>{s.soldBy}</td></tr>
                    <tr><td className="muted">Customer</td><td>{s.customerName}</td></tr>
                    {s.customerEmail && <tr><td className="muted">e-Transfer from</td><td><strong>{s.customerEmail}</strong></td></tr>}
                    <tr><td className="muted">Jerseys</td><td>{itemsText(s)}</td></tr>
                    <tr><td className="muted">Type</td><td>{channelName(s.channel)}{s.shipping > 0 && ` · ${money(s.shipping)} shipping`}</td></tr>
                    {s.whatsappDiscount > 0 && <tr><td className="muted">WhatsApp order</td><td>{money(s.whatsappDiscount)} off (already taken off the total above)</td></tr>}
                    <tr><td className="muted">Logged</td><td>{dateTime(s.createdAt)}</td></tr>
                    {s.notes && <tr><td className="muted">Notes</td><td>{s.notes}</td></tr>}
                  </tbody></table>
                  <div className="actions" style={{ marginTop: 14 }}>
                    <button className="good" disabled={busy === `sale${s.id}`} onClick={() => decide(s, true)}>Approve</button>
                    <button className="bad" disabled={busy === `sale${s.id}`} onClick={() => decide(s, false)}>Reject</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <h2 className="section-title">Jersey updates</h2>
          {updates.data!.length === 0 ? <p className="muted">No jersey updates waiting.</p> : (
            <div className="grid g2">
              {updates.data!.map((u) => (
                <div className="panel" key={u.id}>
                  <div className="panel-head">
                    <h2>{u.quantity > 1 && `${u.quantity}× `}{u.team} {u.kit} <span className="muted small">{u.size}</span></h2>
                    <span className={`badge ${u.kind === 'returned' ? 'good' : 'bad'}`}>{KIND_LABEL[u.kind]}</span>
                  </div>
                  <table><tbody>
                    <tr><td className="muted">From</td><td>{u.associateName}</td></tr>
                    {u.note && <tr><td className="muted">Note</td><td>{u.note}</td></tr>}
                    <tr><td className="muted">Reported</td><td>{dateTime(u.createdAt)}</td></tr>
                    <tr>
                      <td className="muted">If you confirm</td>
                      <td>{u.kind === 'returned' ? 'It goes back into main stock.' : `It comes off their list and ${money(u.cost)} is added to Expenses.`}</td>
                    </tr>
                  </tbody></table>
                  <div className="actions" style={{ marginTop: 14 }}>
                    <button className="good" disabled={busy === `update${u.id}`} onClick={() => decideUpdate(u, true)}>Confirm</button>
                    <button className="bad" disabled={busy === `update${u.id}`} onClick={() => decideUpdate(u, false)}>Decline</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <h2 className="section-title">Stock requests</h2>
          {requests.data!.length === 0 ? <p className="muted">No stock requests waiting.</p> : (
            <div className="grid g2">
              {requests.data!.map((r) => (
                <StockRequestCard key={r.id} r={r} dueBy={dueBy} busy={busy === `request${r.id}`}
                  onApprove={(items) => approveRequest(r, items)} onDecline={() => declineRequest(r)} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
