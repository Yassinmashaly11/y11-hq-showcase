import { FormEvent, useState } from 'react';
import { api, money, shortDate } from '../api';
import { useApi } from '../hooks';
import { Loading, PageHead, Stat } from '../components/ui';

interface Data {
  categories: string[];
  items: { id: number; category: string; description: string | null; amount: number; spentAt: string }[];
  thisMonth: { category: string; total: number }[];
}

export function Expenses() {
  const { data, error, reload } = useApi<Data>('/expenses');
  const [f, setF] = useState({ category: 'Ads', description: '', amount: '', spentAt: new Date().toISOString().slice(0, 10) });
  const [err, setErr] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post('/expenses', { ...f, amount: Number(f.amount), description: f.description || undefined });
      setF({ ...f, description: '', amount: '' }); setErr(null); reload();
    } catch (x: any) { setErr(x.message); }
  }
  if (!data) return <Loading error={error} />;
  const monthTotal = data.thisMonth.reduce((n, c) => n + c.total, 0);

  return (
    <>
      <PageHead title="Expenses" sub="Ads, packaging, fees and anything else. They come off the profit on your Dashboard." />
      <div className="grid g3">
        <Stat hero label="Spent this month" value={money(monthTotal)} />
        <div className="panel span2">
          <h3>This month by category</h3>
          {data.thisMonth.length === 0 ? <p className="muted">Nothing yet this month.</p> : (
            <table style={{ marginTop: 6 }}><tbody>{data.thisMonth.map((c) => <tr key={c.category}><td>{c.category}</td><td className="num">{money(c.total)}</td></tr>)}</tbody></table>
          )}
        </div>
      </div>
      <form className="panel" onSubmit={add}>
        <h2>Add an expense</h2>
        <div className="form-row" style={{ alignItems: 'end', marginTop: 10 }}>
          <label>Category<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{data.categories.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label>What for<input placeholder="e.g. Instagram ads" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <label>Amount (CAD)<input type="number" step="0.01" min="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label>
          <label>Date<input type="date" value={f.spentAt} onChange={(e) => setF({ ...f, spentAt: e.target.value })} /></label>
          <button>Add</button>
        </div>
        {err && <p className="error">{err}</p>}
      </form>
      <div className="panel">
        <h2>All expenses</h2>
        {data.items.length === 0 ? <p className="muted">None yet.</p> : (
          <table style={{ marginTop: 8 }}>
            <thead><tr><th>Date</th><th>Category</th><th>What for</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {data.items.map((x) => (
                <tr key={x.id}>
                  <td>{shortDate(x.spentAt + 'T12:00')}</td><td>{x.category}</td><td>{x.description}</td><td className="num">{money(x.amount)}</td>
                  <td className="num"><button className="link small" onClick={async () => { if (window.confirm('Delete this expense?')) { await api.del(`/expenses/${x.id}`); reload(); } }}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
