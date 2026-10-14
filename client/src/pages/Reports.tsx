import { useState } from 'react';
import { PageHead } from '../components/ui';

const REPORTS = [
  ['sales', 'Sales', 'Every approved order: date, who sold it, customer, jerseys, revenue, cost, profit.'],
  ['commissions', 'Commission & bonuses', 'Every payout line earned by your team, and when it was paid.'],
  ['hours', 'Hours', 'Every shift: start, end, length, and whether it was auto-ended.'],
  ['expenses', 'Expenses', 'Every expense by date and category.'],
] as const;

const firstOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };

export function Reports() {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  return (
    <>
      <PageHead title="Reports" sub="Download spreadsheets (CSV) that open in Excel, Numbers or Google Sheets. Good for taxes and your records." />
      <div className="panel">
        <div className="form-row" style={{ maxWidth: 420 }}>
          <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      </div>
      <div className="grid g2">
        {REPORTS.map(([key, title, desc]) => (
          <div className="panel" key={key}>
            <h2>{title}</h2>
            <p className="muted">{desc}</p>
            <a className="btn" style={{ display: 'inline-block', textDecoration: 'none' }} href={`/api/reports/${key}.csv?from=${from}&to=${to}`}>Download CSV</a>
          </div>
        ))}
      </div>
    </>
  );
}
