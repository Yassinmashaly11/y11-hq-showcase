import { useState } from 'react';
import { dateTime, money } from '../api';
import { useApi } from '../hooks';
import { Loading, PageHead, SaleRow, SalesTable } from '../components/ui';

interface WebsiteOrder {
  saleId: number; createdAt: string; environment: 'live' | 'sandbox'; customerName: string; email: string | null; phone: string | null;
  shipTo: { name: string | null; line1: string | null; line2: string | null; city: string | null; province: string | null; postal: string | null; country: string | null };
  totalPaid: number; associateName: string | null; promoCode: string | null; jerseys: number;
  items: { title: string; team: string | null; kit: string | null; season: string | null; version: string | null; size: string; quantity: number; name: string | null; number: string | null; patch: boolean }[];
  supplierText: string;
}

const dash = <span className="muted">—</span>;

/** One website order, laid out so you can send it straight to the supplier. */
function WebsiteOrderCard({ o }: { o: WebsiteOrder }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(o.supplierText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this for your supplier:', o.supplierText);
    }
  };
  const t = o.shipTo;
  return (
    <div className="panel">
      <div className="panel-head">
        <div>
          <h2>#{o.saleId} · {o.customerName}</h2>
          <p className="small muted">
            {dateTime(o.createdAt)} · {o.jerseys} jersey{o.jerseys === 1 ? '' : 's'} · paid {money(o.totalPaid)}
            {o.associateName && ` · via ${o.associateName}${o.promoCode ? ` (code ${o.promoCode})` : ' (link)'}`}
          </p>
        </div>
        <div className="actions">
          {o.environment === 'sandbox' && <span className="badge warn">Test order</span>}
          <button className="small" onClick={copy}>{copied ? 'Copied' : 'Copy for supplier'}</button>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Team</th><th>Kit</th><th>Jersey</th><th>Size</th><th>Name</th><th>Number</th><th>Patch</th></tr></thead>
          <tbody>
            {o.items.map((i, k) => (
              <tr key={k}>
                <td>{i.team ?? dash}</td>
                <td>{i.kit ?? dash}</td>
                <td>
                  {i.quantity > 1 && <strong>{i.quantity}× </strong>}{i.title}{i.season && <span className="muted"> {i.season}</span>}
                  {i.version && <div className="small muted">{i.version}</div>}
                </td>
                <td><strong>{i.size}</strong></td>
                <td>{i.name ?? dash}</td>
                <td>{i.number ?? dash}</td>
                <td>{i.patch ? 'Yes' : <span className="muted">No</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="small" style={{ marginTop: 12 }}>
        <div className="muted">Ship to</div>
        {[t.name ?? o.customerName, t.line1, t.line2, [t.city, [t.province, t.postal].filter(Boolean).join(' ')].filter(Boolean).join(', '), t.country === 'CA' ? 'Canada' : t.country]
          .filter(Boolean).map((line, k) => <div key={k}>{line}</div>)}
        {o.phone && <div>Phone: {o.phone}</div>}
      </div>
    </div>
  );
}

export function Orders() {
  const [status, setStatus] = useState('');
  const { data, error } = useApi<SaleRow[]>(`/sales${status ? `?status=${status}` : ''}`);
  const website = useApi<WebsiteOrder[]>('/website-orders?limit=20');
  return (
    <>
      <PageHead title="Orders" sub="Every sale from you, your team and the website.">
        <div className="segmented">
          {[['', 'All'], ['approved', 'Approved'], ['pending', 'Pending'], ['rejected', 'Rejected']].map(([k, l]) => (
            <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>
          ))}
        </div>
      </PageHead>

      <h2 className="section-title">Website orders</h2>
      {!website.data ? <Loading error={website.error} />
        : website.data.length === 0 ? <p className="muted">No website orders yet. They appear here as soon as someone pays on y11jerseys.com.</p>
        : <div className="stack">{website.data.map((o) => <WebsiteOrderCard key={o.saleId} o={o} />)}</div>}

      <h2 className="section-title">All orders</h2>
      <div className="panel">{!data ? <Loading error={error} /> : <SalesTable sales={data} showProfit />}</div>
    </>
  );
}
