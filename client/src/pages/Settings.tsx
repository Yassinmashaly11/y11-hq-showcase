import { useEffect, useState } from 'react';
import { api, money } from '../api';
import { useApi } from '../hooks';
import { Loading, PageHead } from '../components/ui';

interface S {
  setSize: number; commissionPerSet: [number, number, number]; levelTargets: { level2: number; level3: number };
  periodMonths: number; warningMonths: number; inHandDays: number; squadDealMin: number;
  extras: { nameNumberPrice: number; nameNumberCost: number; patchPrice: number; patchCost: number; bigSizePrice: number; bigSizeCost: number };
  shipping: { one: number; two: number; freeFrom: number }; whatsappDiscount: number; lowStockAt: number;
  milestones: { jerseys: number; bonus: number }[]; shiftMaxHours: number;
}
interface Type { id: number; name: string; price: number; cost: number }

const Num = ({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (n: number) => void; step?: number }) => (
  <label>{label}<input type="number" step={step} min={0} value={value} onChange={(e) => onChange(Number(e.target.value))} /></label>
);

interface EmailCheck {
  setup: { RESEND_API_KEY: string; ORDER_EMAIL_TO: string; from: string; variablesSeen: string[] };
  sent: boolean; meaning: string; resendStatus?: number | null; resendSays?: string; error?: string;
}

/** Website order emails: send a real test email and show exactly what Resend answered. */
function OrderEmails() {
  const [check, setCheck] = useState<EmailCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { setCheck(await api.get<EmailCheck>('/settings/email-test')); } finally { setBusy(false); }
  };
  return (
    <div className="panel stack">
      <h2>Order emails</h2>
      <p className="small muted">Each paid website order is emailed to you through Resend. This sends a test email and shows Resend's exact answer.</p>
      <div><button className="secondary small" disabled={busy} onClick={run}>{busy ? 'Sending…' : 'Send a test email'}</button></div>
      {check && (
        <div className={`alert ${check.sent ? 'good' : 'bad'}`}>
          <div>{check.meaning}</div>
          <div className="small" style={{ marginTop: 8, fontWeight: 400 }}>
            <div>Key: {check.setup.RESEND_API_KEY}</div>
            <div>To: {check.setup.ORDER_EMAIL_TO}</div>
            <div>From: {check.setup.from}</div>
            <div style={{ marginTop: 6 }}>Variables this server sees with EMAIL, ORDER or RESEND in the name:</div>
            {check.setup.variablesSeen.length
              ? check.setup.variablesSeen.map((v) => <div key={v}>· {v}</div>)
              : <div>· none</div>}
            {check.resendStatus !== undefined && <div>Resend answered: {check.resendStatus ?? 'nothing'} {check.resendSays ?? check.error ?? ''}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Prices() {
  const { data, reload } = useApi<{ types: Type[] }>('/catalog');
  const [rows, setRows] = useState<Type[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (data) setRows(data.types); }, [data]);
  const save = async (t: Type) => {
    try { await api.put(`/product-types/${t.id}`, { price: t.price, cost: t.cost }); setMsg(`Saved ${t.name}`); reload(); } catch (e: any) { setMsg(e.message); }
  };
  return (
    <div className="panel">
      <h2>Jersey prices (CAD)</h2>
      <p className="small muted">Changes apply to new sales. Past sales keep the price they sold at.</p>
      <table>
        <thead><tr><th>Type</th><th>Customer pays</th><th>Costs you</th><th className="num">Profit</th><th /></tr></thead>
        <tbody>
          {rows.map((t, i) => (
            <tr key={t.id}>
              <td>{t.name}</td>
              <td><input type="number" min={0} value={t.price} onChange={(e) => setRows(rows.map((r, k) => k === i ? { ...r, price: Number(e.target.value) } : r))} /></td>
              <td><input type="number" min={0} step={0.5} value={t.cost} onChange={(e) => setRows(rows.map((r, k) => k === i ? { ...r, cost: Number(e.target.value) } : r))} /></td>
              <td className="num">{money(t.price - t.cost)}</td>
              <td className="num"><button className="secondary small" onClick={() => save(t)}>Save</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      {msg && <p className="small muted">{msg}</p>}
    </div>
  );
}

export function Settings() {
  const { data, error } = useApi<S>('/settings');
  const [s, setS] = useState<S | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  useEffect(() => { if (data) setS(data); }, [data]);
  if (!s) return <Loading error={error} />;

  const save = async () => {
    try { setS(await api.put<S>('/settings', s)); setMsg('Settings saved.'); } catch (e: any) { setMsg(e.message); }
  };
  const runChecks = async () => {
    const r = await api.post<{ changed: unknown[] }>('/levels/run-checks');
    setCheck(r.changed.length ? `${r.changed.length} associate(s) updated. See Team for details.` : 'Nobody is due for a check right now.');
  };
  const cps = s.commissionPerSet;
  const setCps = (i: number, v: number) => setS({ ...s, commissionPerSet: cps.map((x, k) => (k === i ? v : x)) as S['commissionPerSet'] });

  return (
    <>
      <PageHead title="Settings" sub="The business rules Y11 HQ runs on." >
        <button onClick={save}>Save settings</button>
      </PageHead>
      {msg && <div className="alert good">{msg}</div>}
      <div className="grid g2">
        <div className="panel stack">
          <h2>Commission</h2>
          <Num label="Jerseys per payout" value={s.setSize} onChange={(v) => setS({ ...s, setSize: v })} />
          <div className="form-row">
            <Num label="Level 1 pays" value={cps[0]} onChange={(v) => setCps(0, v)} />
            <Num label="Level 2 pays" value={cps[1]} onChange={(v) => setCps(1, v)} />
            <Num label="Level 3 pays" value={cps[2]} onChange={(v) => setCps(2, v)} />
          </div>
          <p className="small muted">
            Per jersey: {cps.map((c, i) => `Level ${i + 1} ${money(Math.round((c / s.setSize) * 100) / 100)}`).join(' · ')}
          </p>
        </div>
        <div className="panel stack">
          <h2>Levels</h2>
          <div className="form-row">
            <Num label="Jerseys for Level 2" value={s.levelTargets.level2} onChange={(v) => setS({ ...s, levelTargets: { ...s.levelTargets, level2: v } })} />
            <Num label="Jerseys for Level 3" value={s.levelTargets.level3} onChange={(v) => setS({ ...s, levelTargets: { ...s.levelTargets, level3: v } })} />
          </div>
          <div className="form-row">
            <Num label="Everyone drops a level every (months)" value={s.periodMonths} onChange={(v) => setS({ ...s, periodMonths: v })} />
            <Num label="Warning period (months)" value={s.warningMonths} onChange={(v) => setS({ ...s, warningMonths: v })} />
          </div>
          <div className="actions">
            <button className="secondary small" onClick={runChecks}>Run the level check now</button>
            {check && <span className="small muted">{check}</span>}
          </div>
          <p className="small muted">The check also runs by itself every 10 minutes. It only changes someone's level when their 2 months are up.</p>
        </div>
        <div className="panel stack">
          <h2>Milestone bonuses</h2>
          <p className="small muted">One-time bonus for jerseys sold in a single 2-month period. They stack and reset at each check.</p>
          {s.milestones.map((m, i) => (
            <div className="form-row" key={i} style={{ alignItems: 'end', gridTemplateColumns: '1fr 1fr auto' }}>
              <Num label="Jerseys in a period" value={m.jerseys} onChange={(v) => setS({ ...s, milestones: s.milestones.map((x, k) => (k === i ? { ...x, jerseys: v } : x)) })} />
              <Num label="Bonus (CAD)" value={m.bonus} onChange={(v) => setS({ ...s, milestones: s.milestones.map((x, k) => (k === i ? { ...x, bonus: v } : x)) })} />
              <button type="button" className="secondary small" onClick={() => setS({ ...s, milestones: s.milestones.filter((_, k) => k !== i) })}>Remove</button>
            </div>
          ))}
          <div><button type="button" className="secondary small" onClick={() => setS({ ...s, milestones: [...s.milestones, { jerseys: (s.milestones.at(-1)?.jerseys ?? 30) + 20, bonus: 50 }] })}>+ Add milestone</button></div>
        </div>
        <div className="panel stack">
          <h2>Shifts</h2>
          <Num label="Auto-end a shift after (hours)" value={s.shiftMaxHours} onChange={(v) => setS({ ...s, shiftMaxHours: v })} />
          <p className="small muted">If someone forgets to press End shift, it's closed at exactly this many hours and marked "Auto-ended".</p>
        </div>
        <div className="panel stack">
          <h2>Extras (CAD)</h2>
          <div className="form-row">
            <Num label="Name & number price" value={s.extras.nameNumberPrice} onChange={(v) => setS({ ...s, extras: { ...s.extras, nameNumberPrice: v } })} />
            <Num label="Name & number cost" step={0.5} value={s.extras.nameNumberCost} onChange={(v) => setS({ ...s, extras: { ...s.extras, nameNumberCost: v } })} />
          </div>
          <div className="form-row">
            <Num label="Patch price" value={s.extras.patchPrice} onChange={(v) => setS({ ...s, extras: { ...s.extras, patchPrice: v } })} />
            <Num label="Patch cost" step={0.5} value={s.extras.patchCost} onChange={(v) => setS({ ...s, extras: { ...s.extras, patchCost: v } })} />
          </div>
          <div className="form-row">
            <Num label="2XL/3XL extra price" value={s.extras.bigSizePrice} onChange={(v) => setS({ ...s, extras: { ...s.extras, bigSizePrice: v } })} />
            <Num label="2XL/3XL extra cost" step={0.5} value={s.extras.bigSizeCost} onChange={(v) => setS({ ...s, extras: { ...s.extras, bigSizeCost: v } })} />
          </div>
          <Num label="Squad Deal: free name & number from (jerseys)" value={s.squadDealMin} onChange={(v) => setS({ ...s, squadDealMin: v })} />
          <Num label="WhatsApp discount (off each jersey)" value={s.whatsappDiscount} onChange={(v) => setS({ ...s, whatsappDiscount: v })} />
          <p className="small muted">Applies when a sale is logged as a WhatsApp order. Keep it the same as the website's WhatsApp offer.</p>
        </div>
        <div className="panel stack">
          <h2>Shipping and stock</h2>
          <div className="form-row">
            <Num label="1 jersey" value={s.shipping.one} onChange={(v) => setS({ ...s, shipping: { ...s.shipping, one: v } })} />
            <Num label="2 jerseys (total)" value={s.shipping.two} onChange={(v) => setS({ ...s, shipping: { ...s.shipping, two: v } })} />
            <Num label="Free from" value={s.shipping.freeFrom} onChange={(v) => setS({ ...s, shipping: { ...s.shipping, freeFrom: v } })} />
          </div>
          <p className="small muted">Shipping is passed straight to the supplier, so it doesn't count as revenue or profit.</p>
          <div className="form-row">
            <Num label="In-hand jerseys due back after (days)" value={s.inHandDays} onChange={(v) => setS({ ...s, inHandDays: v })} />
            <Num label="Low-stock alert at or below" value={s.lowStockAt} onChange={(v) => setS({ ...s, lowStockAt: v })} />
          </div>
        </div>
        <OrderEmails />
      </div>
      <Prices />
    </>
  );
}
