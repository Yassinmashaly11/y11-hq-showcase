import { useEffect, useState } from 'react';
import { api, dateTime } from '../api';
import { useApi } from '../hooks';
import { Loading, PageHead, Stat } from '../components/ui';

interface Shifts {
  open: { id: number; startedAt: string } | null;
  shifts: { id: number; startedAt: string; endedAt: string | null; autoEnded: boolean }[];
  totals: { week: number; month: number; allTime: number };
  maxHours: number;
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

export function ShiftTimer() {
  const { data, error, reload } = useApi<Shifts>('/shifts/me');
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!data) return <Loading error={error} />;
  const toggle = async () => {
    setBusy(true);
    try { await api.post(data.open ? '/shifts/end' : '/shifts/start'); await reload(); } finally { setBusy(false); }
  };

  return (
    <>
      <PageHead title="Shift Timer" sub="Start when you begin working, end when you stop." />
      <div className="panel" style={{ textAlign: 'center', padding: 36 }}>
        <div className="timer">{data.open ? clock(now - new Date(data.open.startedAt).getTime()) : '00:00:00'}</div>
        <p className="muted">{data.open ? `On shift since ${dateTime(data.open.startedAt)}` : 'Not on shift'}</p>
        <p className="small muted">Shifts end automatically after {data.maxHours} hours if you forget to press End.</p>
        <button className={data.open ? 'bad' : 'good'} style={{ fontSize: 16, padding: '12px 28px' }} disabled={busy} onClick={toggle}>
          {data.open ? 'End shift' : 'Start shift'}
        </button>
      </div>
      <div className="grid g3" style={{ marginTop: 16 }}>
        <Stat label="This week" value={`${data.totals.week} h`} />
        <Stat label="This month" value={`${data.totals.month} h`} />
        <Stat label="All time" value={`${data.totals.allTime} h`} />
      </div>
      <div className="panel">
        <h2>Shift log</h2>
        <table style={{ marginTop: 8 }}>
          <thead><tr><th>Started</th><th>Ended</th><th className="num">Length</th></tr></thead>
          <tbody>
            {data.shifts.map((s) => {
              const end = s.endedAt ? new Date(s.endedAt).getTime() : now;
              return (
                <tr key={s.id}>
                  <td>{dateTime(s.startedAt)}</td>
                  <td>{s.endedAt ? dateTime(s.endedAt) : <span className="badge good">Running</span>}{s.autoEnded && <span className="badge warn" style={{ marginLeft: 8 }}>Auto-ended</span>}</td>
                  <td className="num">{((end - new Date(s.startedAt).getTime()) / 3.6e6).toFixed(1)} h</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
