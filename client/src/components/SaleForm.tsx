import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api, money } from '../api';
import { useApi } from '../hooks';

interface Variant { id: number; size: string; stock: number | null }
interface Product { id: number; team: string; kit: string; season: string | null; typeId: number; active: boolean; variants: Variant[] }
interface Catalog { types: { id: number; name: string; price: number }[]; products: Product[]; canSeeStock: boolean }
interface InHand {
  id: number; variantId: number; quantity: number; team: string; kit: string; size: string; pendingUpdate: object | null; inPendingSale: number;
}

interface Line { variantId: number; quantity: number; nameNumber: boolean; customText: string; patch: boolean }
const blankLine = (): Line => ({ variantId: 0, quantity: 1, nameNumber: false, customText: '', patch: false });

/**
 * The Add Sale form. Associates choose in-hand jerseys or main stock; the CEO always sells from main stock.
 * `preselect`: an in-hand jersey size to start with (from "Sold" on the Stock page).
 */
export function SaleForm({ isOwner, preselect, onDone }: { isOwner: boolean; preselect?: number; onDone: () => void }) {
  const catalog = useApi<Catalog>('/catalog');
  const inHand = useApi<InHand[]>(isOwner ? null : '/in-hand');

  const [source, setSource] = useState<'in_hand' | 'stock'>(isOwner ? 'stock' : 'in_hand');
  const [payment, setPayment] = useState<'etransfer' | 'cash'>('etransfer');
  const [whatsapp, setWhatsapp] = useState(false);
  const [customerName, setName] = useState('');
  const [customerEmail, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([{ ...blankLine(), variantId: preselect ?? 0 }]);
  const [quote, setQuote] = useState<{ total: number; shipping: number; squadDeal: boolean; jerseyCount: number; whatsappDiscount: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Every size the person can pick from right now, as [variantId, label, available]
  const options = useMemo(() => {
    if (source === 'in_hand') {
      const byVariant = new Map<number, { label: string; qty: number }>();
      // Jerseys waiting for Yassin (reported returned / lost / damaged, or already in a pending sale) can't be sold
      for (const h of (inHand.data ?? []).filter((x) => !x.pendingUpdate)) {
        const cur = byVariant.get(h.variantId);
        byVariant.set(h.variantId, { label: `${h.team} ${h.kit} — ${h.size}`, qty: (cur?.qty ?? 0) + h.quantity - h.inPendingSale });
      }
      return [...byVariant].filter(([, v]) => v.qty > 0).map(([id, v]) => ({ id, label: v.label, available: v.qty as number | null }));
    }
    return (catalog.data?.products ?? []).filter((p) => p.active).flatMap((p) =>
      p.variants.map((v) => ({ id: v.id, label: `${p.team} ${p.kit}${p.season ? ' ' + p.season : ''} — ${v.size}`, available: v.stock })),
    ).filter((o) => o.available === null || o.available > 0);
  }, [source, catalog.data, inHand.data]);

  const ready = lines.filter((l) => l.variantId);

  // Ask the server for the price whenever the jerseys change, so the total is always right.
  useEffect(() => {
    if (!ready.length) return setQuote(null);
    const t = setTimeout(() => {
      api.post<any>('/sales/quote', { source, paymentMethod: payment, whatsapp, customerName: 'x', items: ready })
        .then(setQuote).catch(() => setQuote(null));
    }, 200);
    return () => clearTimeout(t);
  }, [JSON.stringify(ready), source, whatsapp]);

  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.post('/sales', {
        source, paymentMethod: payment, whatsapp, customerName, customerEmail, notes: notes || undefined,
        items: ready.map((l) => ({ ...l, customText: l.nameNumber ? l.customText : undefined })),
      });
      setLines([blankLine()]); setName(''); setEmail(''); setNotes(''); setWhatsapp(false);
      inHand.reload(); catalog.reload();
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="panel stack" onSubmit={submit}>
      {!isOwner && (
        <div>
          <label>Where is the jersey coming from?</label>
          <div className="segmented" style={{ marginTop: 6 }}>
            <button type="button" className={source === 'in_hand' ? 'on' : ''} onClick={() => { setSource('in_hand'); setLines([blankLine()]); }}>
              Jerseys in my hand
            </button>
            <button type="button" className={source === 'stock' ? 'on' : ''} onClick={() => { setSource('stock'); setLines([blankLine()]); }}>
              Order from main stock
            </button>
          </div>
        </div>
      )}

      {source === 'in_hand' && options.length === 0 && <p className="muted">You don't have any jerseys in hand right now.</p>}

      {lines.map((l, i) => {
        const opt = options.find((o) => o.id === l.variantId);
        return (
          <div key={i} className="form-row" style={{ alignItems: 'end', gridTemplateColumns: '2.4fr 0.6fr 1.6fr auto' }}>
            <label>Jersey and size
              <select value={l.variantId} onChange={(e) => update(i, { variantId: Number(e.target.value) })}>
                <option value={0}>Choose…</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}{o.available !== null ? ` (${o.available} available)` : ''}</option>
                ))}
              </select>
            </label>
            <label>Qty
              <input type="number" min={1} max={opt?.available ?? 99} value={l.quantity}
                onChange={(e) => update(i, { quantity: Math.max(1, Number(e.target.value)) })} />
            </label>
            <div>
              <label className="check"><input type="checkbox" checked={l.nameNumber} onChange={(e) => update(i, { nameNumber: e.target.checked })} /> Name &amp; number</label>
              {l.nameNumber && <input placeholder="e.g. MESSI 10" value={l.customText} onChange={(e) => update(i, { customText: e.target.value })} style={{ marginTop: 6 }} />}
              <label className="check" style={{ marginTop: 6 }}><input type="checkbox" checked={l.patch} onChange={(e) => update(i, { patch: e.target.checked })} /> Patch</label>
            </div>
            <button type="button" className="secondary small" disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>Remove</button>
          </div>
        );
      })}
      <div><button type="button" className="secondary small" onClick={() => setLines((ls) => [...ls, blankLine()])}>+ Add another jersey</button></div>

      <div className="form-row">
        <label>Customer name<input required value={customerName} onChange={(e) => setName(e.target.value)} /></label>
        <label>How did they pay?
          <select value={payment} onChange={(e) => setPayment(e.target.value as any)}>
            <option value="etransfer">e-Transfer to Yassin</option>
            <option value="cash">Cash</option>
          </select>
        </label>
        {payment === 'etransfer' && (
          <label>Email the e-Transfer came from<input type="email" required value={customerEmail} onChange={(e) => setEmail(e.target.value)} /></label>
        )}
      </div>
      <label className="check">
        <input type="checkbox" checked={whatsapp} onChange={(e) => setWhatsapp(e.target.checked)} /> WhatsApp order: the customer ordered on WhatsApp and gets the WhatsApp discount on every jersey
      </label>
      <label>Notes (optional)<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>

      {quote && (
        <div className="alert good">
          Customer pays <strong>{money(quote.total)}</strong> for {quote.jerseyCount} jersey{quote.jerseyCount > 1 ? 's' : ''}
          {quote.shipping > 0 ? ` (includes ${money(quote.shipping)} shipping)` : source === 'stock' ? ' (free shipping)' : ''}
          {quote.squadDeal && ' · Squad Deal: names & numbers free'}
          {quote.whatsappDiscount > 0 && ` · WhatsApp discount: −${money(quote.whatsappDiscount)}`}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button disabled={saving || !ready.length}>{saving ? 'Saving…' : isOwner ? 'Save sale' : 'Submit for approval'}</button>
        {!isOwner && <span className="small muted">It counts toward your level and payout once Yassin approves it.</span>}
      </div>
    </form>
  );
}
