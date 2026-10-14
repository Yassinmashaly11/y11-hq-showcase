import { useState } from 'react';
import { useApi } from '../hooks';
import { LevelBadge, Loading, PageHead } from '../components/ui';

interface Row { id: number; name: string; level: number; role?: 'owner' | 'associate'; jerseys: number; rank: number; isMe: boolean }
const RANGES = [['week', 'This week'], ['month', 'This month'], ['period', 'Current 2-month period'], ['all', 'All time']] as const;

export function Leaderboard() {
  const [range, setRange] = useState<(typeof RANGES)[number][0]>('month');
  const { data, error } = useApi<Row[]>(`/leaderboard?range=${range}`);

  return (
    <>
      <PageHead title="Leaderboard" sub={range === 'period' ? "Approved jerseys only. Associates: their current 2-month period. CEO: the last 2 months." : 'Approved jerseys only.'}>
        <div className="segmented">
          {RANGES.map(([k, l]) => <button key={k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{l}</button>)}
        </div>
      </PageHead>

      <div className="panel">
        {!data ? <Loading error={error} /> : data.length === 0 ? <p className="empty">No associates yet.</p> : (
          <table>
            <thead><tr><th>#</th><th>Name</th><th>Level</th><th className="num">Jerseys</th></tr></thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id} className={r.isMe ? 'me' : ''}>
                  <td className="rank">{r.rank}</td>
                  <td>{r.name}{r.isMe && <span className="badge good" style={{ marginLeft: 8 }}>You</span>}</td>
                  <td>{r.role === 'owner' ? <span className="badge" style={{ background: '#141414', color: '#fff' }}>CEO</span> : <LevelBadge level={r.level} />}</td>
                  <td className="num"><strong>{r.jerseys}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
