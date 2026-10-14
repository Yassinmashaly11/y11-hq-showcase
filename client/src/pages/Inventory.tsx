import { FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, money, shortDate } from '../api';
import { useApi } from '../hooks';
import { Loading, PageHead } from '../components/ui';
import { KIND_LABEL } from './Stock';

interface Variant { id: number; size: string; stock: number }
interface Product { id: number; team: string; kit: string; season: string | null; typeId: number; active: boolean; variants: Variant[] }
interface Catalog { types: { id: number; name: string; price: number; cost: number }[]; products: Product[] }
interface InHand {
  id: number; associateId: number; associateName: string; variantId: number; quantity: number; dueAt: string; overdue: boolean;
  team: string; kit: string; size: string; pendingUpdate: { kind: keyof typeof KIND_LABEL } | null; inPendingSale: number;
}
interface Associate { id: number; name: string; active: boolean }

const SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL'];

function AddProduct({ types, onDone }: { types: Catalog['types']; onDone: () => void }) {
  const [team, setTeam] = useState('');
  const [kit, setKit] = useState('Home');
  const [season, setSeason] = useState('');
  const [typeId, setTypeId] = useState(types[0]?.id ?? 0);
  const [stock, setStock] = useState<Record<string, number>>({ S: 0, M: 0, L: 0, XL: 0 });
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post('/products', {
        team, kit, season: season || undefined, typeId,
        sizes: Object.entries(stock).map(([size, n]) => ({ size, stock: n })),
      });
      setTeam(''); setSeason(''); setError(null);
      onDone();
    } catch (err: any) { setError(err.message); }
  }

  return (
    <form className="panel stack" onSubmit={submit}>
      <h2>Add a jersey</h2>
      <div className="form-row">
        <label>Team<input required placeholder="e.g. Real Madrid" value={team} onChange={(e) => setTeam(e.target.value)} /></label>
        <label>Kit<input required value={kit} onChange={(e) => setKit(e.target.value)} /></label>
        <label>Season<input placeholder="25/26" value={season} onChange={(e) => setSeason(e.target.value)} /></label>
        <label>Type
          <select value={typeId} onChange={(e) => setTypeId(Number(e.target.value))}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name} · {money(t.price)}</option>)}
          </select>
        </label>
      </div>
      <div>
        <label>How many of each size?</label>
        <div className="form-row" style={{ marginTop: 6, gridTemplateColumns: 'repeat(6, minmax(70px, 1fr))' }}>
          {SIZES.map((s) => (
            <label key={s}>{s}
              <input type="number" min={0} value={stock[s] ?? ''} placeholder="—"
                onChange={(e) => setStock((st) => {
                  const n = { ...st };
                  if (e.target.value === '') delete n[s]; else n[s] = Number(e.target.value);
                  return n;
                })} />
            </label>
          ))}
        </div>
        <p className="small muted">Leave a size empty if you don't carry it.</p>
      </div>
      {error && <p className="error">{error}</p>}
      <div><button>Add jersey</button></div>
    </form>
  );
}

function GiveOut({ catalog, team, onDone }: { catalog: Catalog; team: Associate[]; onDone: () => void }) {
  const [associateId, setA] = useState(team[0]?.id ?? 0);
  const [variantId, setV] = useState(0);
  const [quantity, setQ] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const options = catalog.products.filter((p) => p.active).flatMap((p) => p.variants.filter((v) => v.stock > 0).map((v) => ({ id: v.id, label: `${p.team} ${p.kit} — ${v.size} (${v.stock} in stock)` })));

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post('/in-hand', { associateId, variantId, quantity });
      setV(0); setQ(1); setError(null);
      onDone();
    } catch (err: any) { setError(err.message); }
  }
  if (!team.length) return <p className="muted">Add an associate in Team first.</p>;
  return (
    <form onSubmit={submit}>
      <div className="form-row" style={{ alignItems: 'end', gridTemplateColumns: '1fr 2fr 0.5fr auto' }}>
        <label>Give to<select value={associateId} onChange={(e) => setA(Number(e.target.value))}>{team.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
        <label>Jersey<select value={variantId} onChange={(e) => setV(Number(e.target.value))}><option value={0}>Choose…</option>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
        <label>Qty<input type="number" min={1} value={quantity} onChange={(e) => setQ(Number(e.target.value))} /></label>
        <button disabled={!variantId}>Give out</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

export function Inventory() {
  const catalog = useApi<Catalog>('/catalog');
  const inHand = useApi<InHand[]>('/in-hand');
  const team = useApi<Associate[]>('/team');
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const reloadAll = () => { catalog.reload(); inHand.reload(); };
  const setStock = async (v: Variant) => {
    const n = window.prompt(`Set stock for ${v.size}`, String(v.stock));
    if (n === null) return;
    try { await api.patch(`/variants/${v.id}`, { stock: Number(n) }); catalog.reload(); } catch (e: any) { setErr(e.message); }
  };
  const giveBack = async (h: InHand) => {
    if (!window.confirm(`Mark ${h.quantity}× ${h.team} ${h.kit} (${h.size}) as returned by ${h.associateName}?`)) return;
    try { await api.post(`/in-hand/${h.id}/return`, {}); reloadAll(); } catch (e: any) { setErr(e.message); }
  };

  if (!catalog.data) return <Loading error={catalog.error} />;
  const c = catalog.data;
  const typeName = (id: number) => c.types.find((t) => t.id === id)?.name ?? '';
  const mainTotal = c.products.reduce((n, p) => n + p.variants.reduce((m, v) => m + v.stock, 0), 0);
  const handTotal = (inHand.data ?? []).reduce((n, h) => n + h.quantity, 0);
  const byAssociate = new Map<string, InHand[]>();
  for (const h of inHand.data ?? []) byAssociate.set(h.associateName, [...(byAssociate.get(h.associateName) ?? []), h]);

  return (
    <>
      <PageHead title="Inventory" sub={`${mainTotal} jerseys in main stock · ${handTotal} with your team`}>
        <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ Add jersey'}</button>
      </PageHead>
      {err && <div className="alert bad">{err}</div>}
      {adding && <AddProduct types={c.types} onDone={() => { setAdding(false); catalog.reload(); }} />}

      <div className="panel">
        <div className="panel-head"><h2>In-hand stock</h2></div>
        <GiveOut catalog={c} team={(team.data ?? []).filter((a) => a.active)} onDone={reloadAll} />
        <div className="grid g2" style={{ marginTop: 16 }}>
          {[...byAssociate].map(([name, rows]) => (
            <div key={name}>
              <h3>{name} <span className="muted small">· {rows.reduce((n, r) => n + r.quantity, 0)} jerseys</span></h3>
              <table><tbody>
                {rows.map((h) => (
                  <tr key={h.id}>
                    <td>
                      {h.quantity > 1 && `${h.quantity}× `}{h.team} {h.kit} <span className="muted">{h.size}</span>
                      {h.inPendingSale > 0 && <div className="small muted">{h.inPendingSale} in a sale waiting for approval</div>}
                    </td>
                    <td className="small">{h.overdue ? <span className="badge bad">Overdue {shortDate(h.dueAt)}</span> : <span className="muted">Due {shortDate(h.dueAt)}</span>}</td>
                    <td className="num">
                      {h.pendingUpdate
                        ? <Link to="/approvals" className="badge warn">{KIND_LABEL[h.pendingUpdate.kind]}: waiting for you</Link>
                        : <button className="secondary small" onClick={() => giveBack(h)}>Returned</button>}
                    </td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          ))}
          {byAssociate.size === 0 && <p className="muted">No jerseys out with the team.</p>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Main stock</h2><span className="small muted">Click a number to change it</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Jersey</th><th>Type</th>{SIZES.map((s) => <th key={s} className="num">{s}</th>)}<th className="num">Total</th><th /></tr></thead>
            <tbody>
              {c.products.map((p) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                  <td><strong>{p.team}</strong> {p.kit}<div className="small muted">{p.season}</div></td>
                  <td className="small">{typeName(p.typeId)}</td>
                  {SIZES.map((s) => {
                    const v = p.variants.find((x) => x.size === s);
                    return (
                      <td key={s} className="num">
                        {v ? <button className={`small ${v.stock === 0 ? 'bad' : 'secondary'}`} onClick={() => setStock(v)}>{v.stock}</button> : <span className="muted">—</span>}
                      </td>
                    );
                  })}
                  <td className="num"><strong>{p.variants.reduce((n, v) => n + v.stock, 0)}</strong></td>
                  <td className="num">
                    <button className="link small" onClick={async () => { await api.patch(`/products/${p.id}`, { active: !p.active }); catalog.reload(); }}>
                      {p.active ? 'Hide' : 'Show'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
