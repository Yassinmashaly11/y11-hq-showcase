import { FormEvent, Fragment, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, money, shortDate } from '../api';
import { useApi } from '../hooks';
import { Loading, PageHead } from '../components/ui';

interface Catalog {
  types: { id: number; name: string; price: number }[];
  products: { id: number; team: string; kit: string; season: string | null; typeId: number; variants: { id: number; size: string; stock: number | null }[] }[];
  canSeeStock: boolean;
}
type Kind = 'returned' | 'lost' | 'damaged';
interface InHand {
  id: number; variantId: number; quantity: number; dueAt: string; overdue: boolean; team: string; kit: string; size: string;
  pendingUpdate: { kind: Kind } | null; inPendingSale: number;
}
interface Mine {
  given: number; sold: number; returned: number; lostOrDamaged: number; left: number;
  recentlySold: { id: number; team: string; kit: string; size: string; quantity: number; soldAt: string }[];
}
interface StockRequest {
  id: number; note: string | null; status: 'pending' | 'approved' | 'declined'; createdAt: string; decidedAt: string | null;
  items: { id: number; team: string; kit: string; size: string; quantity: number; approved: number | null }[];
}
type Mode = 'returned' | 'problem';

export const KIND_LABEL: Record<Kind, string> = { returned: 'Returned', lost: 'Lost or stolen', damaged: 'Damaged' };

const Jersey = ({ qty, j }: { qty: number; j: { team: string; kit: string; size: string } }) =>
  <>{qty > 1 && `${qty}× `}{j.team} {j.kit} <span className="muted">{j.size}</span></>;

/** "I returned it" / "Report a problem". It's sent to Yassin; nothing changes until he confirms. */
function UpdateForm({ h, available, mode, onDone, onCancel }: { h: InHand; available: number; mode: Mode; onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<Kind>(mode === 'returned' ? 'returned' : 'lost');
  const [quantity, setQuantity] = useState(mode === 'returned' ? available : 1);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post(`/in-hand/${h.id}/updates`, { kind, quantity, note: note || undefined });
      onDone();
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <div className="form-row">
        {mode === 'problem' && (
          <label>What happened?
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="lost">{KIND_LABEL.lost}</option>
              <option value="damaged">{KIND_LABEL.damaged}</option>
            </select>
          </label>
        )}
        {available > 1 && (
          <label>How many?<input type="number" min={1} max={available} value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} /></label>
        )}
        <label>Note (optional)
          <input maxLength={300} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder={mode === 'returned' ? 'e.g. gave it back at practice' : 'e.g. torn sleeve'} />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button disabled={saving}>Send to Yassin</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        <span className="small muted">Nothing changes until Yassin confirms it.</span>
      </div>
    </form>
  );
}

/** Ask for more jerseys from main stock. Yassin approves (maybe fewer) and hands them over. */
function RequestForm({ catalog, onDone, onCancel }: { catalog: Catalog; onDone: () => void; onCancel: () => void }) {
  const [lines, setLines] = useState([{ variantId: 0, quantity: 1 }]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const options = catalog.products.flatMap((p) => p.variants.filter((v) => v.stock === null || v.stock > 0).map((v) => ({
    id: v.id, stock: v.stock, label: `${p.team} ${p.kit}${p.season ? ' ' + p.season : ''} — ${v.size}${v.stock !== null ? ` (${v.stock} in stock)` : ''}`,
  })));
  const update = (i: number, patch: Partial<(typeof lines)[number]>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const ready = lines.filter((l) => l.variantId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    // The same jersey picked twice becomes one line
    const merged = new Map<number, number>();
    for (const l of ready) merged.set(l.variantId, (merged.get(l.variantId) ?? 0) + l.quantity);
    setSaving(true);
    try {
      await api.post('/stock-requests', { items: [...merged].map(([variantId, quantity]) => ({ variantId, quantity })), note: note || undefined });
      onDone();
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <form className="panel stack" onSubmit={submit}>
      <h2>Request more jerseys</h2>
      {lines.map((l, i) => (
        <div key={i} className="form-row" style={{ alignItems: 'end', gridTemplateColumns: '3fr 0.7fr auto' }}>
          <label>Jersey and size
            <select value={l.variantId} onChange={(e) => update(i, { variantId: Number(e.target.value) })}>
              <option value={0}>Choose…</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
          <label>How many?
            <input type="number" min={1} max={options.find((o) => o.id === l.variantId)?.stock ?? 99} value={l.quantity}
              onChange={(e) => update(i, { quantity: Math.max(1, Number(e.target.value)) })} />
          </label>
          <button type="button" className="secondary small" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>Remove</button>
        </div>
      ))}
      <div><button type="button" className="secondary small" onClick={() => setLines((ls) => [...ls, { variantId: 0, quantity: 1 }])}>+ Add another jersey</button></div>
      <label>Note (optional)<input maxLength={300} value={note} placeholder="e.g. tournament on Saturday" onChange={(e) => setNote(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button disabled={saving || !ready.length}>Send request</button>
        <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        <span className="small muted">Yassin can approve fewer than you ask for.</span>
      </div>
    </form>
  );
}

function Tally({ m }: { m: Mine }) {
  const parts: [string, number][] = [['Given', m.given], ['Sold', m.sold]];
  if (m.returned) parts.push(['Returned', m.returned]);
  if (m.lostOrDamaged) parts.push(['Lost or damaged', m.lostOrDamaged]);
  parts.push(['Left', m.left]);
  return <p className="tally">{parts.map(([label, n], i) => <Fragment key={label}>{i > 0 && ' · '}{label} <strong>{n}</strong></Fragment>)}</p>;
}

function RequestStatus({ r }: { r: StockRequest }) {
  if (r.status === 'approved') return <span className="badge good">Approved {r.decidedAt && shortDate(r.decidedAt)}</span>;
  if (r.status === 'declined') return <span className="badge bad">Declined</span>;
  return <span className="badge warn">Waiting for Yassin</span>;
}

export function Stock() {
  const nav = useNavigate();
  const catalog = useApi<Catalog>('/catalog');
  const inHand = useApi<InHand[]>('/in-hand');
  const mine = useApi<Mine>('/in-hand/mine');
  const requests = useApi<StockRequest[]>('/stock-requests');
  const [open, setOpen] = useState<{ id: number; mode: Mode } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [sent, setSent] = useState(false);
  if (!catalog.data) return <Loading error={catalog.error} />;
  const c = catalog.data;
  const type = (id: number) => c.types.find((t) => t.id === id);
  const rows = inHand.data ?? [];
  const sold = mine.data?.recentlySold ?? [];

  return (
    <>
      <PageHead title="Stock" sub="Your jerseys in hand, and what's available to order.">
        <button onClick={() => { setRequesting((v) => !v); setSent(false); }}>{requesting ? 'Close' : 'Request more jerseys'}</button>
      </PageHead>
      {sent && <div className="alert good">Request sent. You'll get a notification when Yassin answers.</div>}
      {requesting && (
        <RequestForm catalog={c} onCancel={() => setRequesting(false)} onDone={() => { setRequesting(false); setSent(true); requests.reload(); }} />
      )}

      <div className="panel">
        <h2>My jerseys in hand</h2>
        {mine.data && mine.data.given > 0 && <Tally m={mine.data} />}
        {!rows.length && !sold.length ? <p className="muted">You don't have any jerseys right now.</p> : (
          <>
            <p className="small muted">Sold one? Press Sold to log the sale. Gave one back, or lost or damaged one? Tell Yassin here.</p>
            <table style={{ marginTop: 8 }}><tbody>
              {rows.map((h) => {
                if (h.pendingUpdate) {
                  return (
                    <tr key={h.id}>
                      <td><Jersey qty={h.quantity} j={h} /></td>
                      <td className="num"><span className="badge warn">Waiting for Yassin · {KIND_LABEL[h.pendingUpdate.kind]}</span></td>
                      <td />
                    </tr>
                  );
                }
                const free = h.quantity - h.inPendingSale;
                return (
                  <Fragment key={h.id}>
                    {h.inPendingSale > 0 && (
                      <tr>
                        <td><Jersey qty={h.inPendingSale} j={h} /></td>
                        <td className="num"><span className="badge warn">Sale waiting for Yassin</span></td>
                        <td />
                      </tr>
                    )}
                    {free > 0 && (
                      <tr>
                        <td><Jersey qty={free} j={h} /></td>
                        <td className="num">
                          {h.overdue ? <span className="badge bad">Overdue since {shortDate(h.dueAt)}</span> : <span className="small muted">Return by {shortDate(h.dueAt)}</span>}
                        </td>
                        <td className="num">
                          <div className="actions" style={{ justifyContent: 'flex-end' }}>
                            <button className="small" onClick={() => nav(`/add-sale?jersey=${h.variantId}`)}>Sold</button>
                            <button className="secondary small" onClick={() => setOpen({ id: h.id, mode: 'returned' })}>I returned it</button>
                            <button className="secondary small" onClick={() => setOpen({ id: h.id, mode: 'problem' })}>Report a problem</button>
                          </div>
                        </td>
                      </tr>
                    )}
                    {open?.id === h.id && free > 0 && (
                      <tr>
                        <td colSpan={3}>
                          <UpdateForm key={open.mode} h={h} available={free} mode={open.mode} onCancel={() => setOpen(null)}
                            onDone={() => { setOpen(null); inHand.reload(); mine.reload(); }} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {sold.map((s) => (
                <tr key={`sold${s.id}`} className="sold">
                  <td><Jersey qty={s.quantity} j={s} /></td>
                  <td className="num"><span className="badge good">Sold · {shortDate(s.soldAt)}</span></td>
                  <td />
                </tr>
              ))}
            </tbody></table>
          </>
        )}
      </div>

      {!!requests.data?.length && (
        <div className="panel">
          <h2>My requests</h2>
          <table style={{ marginTop: 8 }}><tbody>
            {requests.data.map((r) => (
              <tr key={r.id}>
                <td className="small">{shortDate(r.createdAt)}</td>
                <td>
                  {r.items.map((i) => (
                    <div key={i.id}>
                      <Jersey qty={i.quantity} j={i} />
                      {r.status === 'approved' && i.approved !== i.quantity && <span className="small muted"> · Yassin gave you {i.approved}</span>}
                    </div>
                  ))}
                  {r.note && <div className="small muted">{r.note}</div>}
                </td>
                <td className="num"><RequestStatus r={r} /></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}

      <div className="panel">
        <h2>Main stock</h2>
        {!c.canSeeStock && <p className="small muted">Yassin hasn't turned on stock counts for you. You can still see what Y11 sells.</p>}
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Jersey</th><th>Price</th><th>Sizes</th></tr></thead>
          <tbody>
            {c.products.map((p) => (
              <tr key={p.id}>
                <td><strong>{p.team}</strong> {p.kit} <span className="muted small">{p.season}</span><div className="small muted">{type(p.typeId)?.name}</div></td>
                <td>{money(type(p.typeId)?.price ?? 0)}</td>
                <td>
                  <div className="actions">
                    {p.variants.map((v) => (
                      <span key={v.id} className={`badge ${v.stock === 0 ? 'bad' : ''}`}>{v.size}{v.stock !== null && ` · ${v.stock}`}</span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
