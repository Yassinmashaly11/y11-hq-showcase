import { useState } from 'react';
import { money, shortDate } from '../api';
import { useApi } from '../hooks';
import { Loading, PageHead, Stat } from '../components/ui';

interface C { name: string; email: string | null; orders: number; jerseys: number; spent: number; firstOrder: string; lastOrder: string; soldBy: string }

export function Customers() {
  const { data, error } = useApi<{ customers: C[]; total: number; repeat: number }>('/customers');
  const [q, setQ] = useState('');
  if (!data) return <Loading error={error} />;
  const list = data.customers.filter((c) => `${c.name} ${c.email ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <PageHead title="Customers" sub="Everyone who has bought from Y11, matched by email (or name if there's no email)." />
      <div className="grid g3">
        <Stat label="Customers" value={data.total} />
        <Stat label="Repeat buyers" value={data.repeat} note={data.total ? `${Math.round((data.repeat / data.total) * 100)}% came back` : undefined} />
        <Stat label="Top customer" value={data.customers[0] ? money(data.customers[0].spent) : '—'} note={data.customers[0]?.name} />
      </div>
      <div className="panel">
        <div className="panel-head"><h2>All customers</h2><input placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} /></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Customer</th><th className="num">Orders</th><th className="num">Jerseys</th><th className="num">Spent</th><th>Last order</th><th>Sold by</th></tr></thead>
            <tbody>
              {list.map((c, i) => (
                <tr key={i}>
                  <td>{c.name}{c.orders > 1 && <span className="badge good" style={{ marginLeft: 8 }}>Repeat</span>}<div className="small muted">{c.email}</div></td>
                  <td className="num">{c.orders}</td><td className="num">{c.jerseys}</td><td className="num"><strong>{money(c.spent)}</strong></td>
                  <td className="small">{shortDate(c.lastOrder)}</td><td className="small">{c.soldBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
