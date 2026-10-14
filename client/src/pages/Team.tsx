import { FormEvent, useState } from 'react';
import { api, money, shortDate, dateTime } from '../api';
import { useApi } from '../hooks';
import { LevelBadge, Loading, PageHead, Progress } from '../components/ui';

interface Associate {
  id: number; name: string; username: string; active: boolean; canSeeStock: boolean; joinedAt: string;
  level: number; periodJerseys: number; setProgress: number; skipNextCheck: boolean; warningDeadline: string | null;
  pendingRemoval: boolean; jerseysAllTime: number; commissionEarned: number; commissionUnpaid: number; cashOwed: number;
  jerseysInHand: number; jerseysOverdue: number; pendingSales: number; hoursThisMonth: number; hoursAllTime: number;
  onShiftSince: string | null; madeForYou: number; nextLevel: number | null; periodTarget: number | null; setSize: number; jerseysToNextLevel: number; nextCheckAt: string;
}

const EVENT: Record<string, string> = {
  level_up: 'Levelled up', warning_cleared: 'Cleared the warning', period_drop: '2-month drop',
  first_check_skipped: 'First check skipped (new)', milestone: 'Milestone bonus', warning: 'Warning', removal_flag: 'Missed the deadline',
  removed: 'Removed', kept: 'Given another chance',
};

function AddAssociate({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ fullName: '', username: '', password: '' });
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await api.post('/team', f);
      setF({ fullName: '', username: '', password: '' });
      setError(null);
      onDone();
    } catch (err: any) { setError(err.message); }
  }
  return (
    <form className="panel" onSubmit={submit}>
      <h2>Add an associate</h2>
      <p className="muted small">They start at Level 1 and skip their first 2-month check.</p>
      <div className="form-row" style={{ alignItems: 'end' }}>
        <label>Full name<input required value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></label>
        <label>Username<input required value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></label>
        <label>Starting password<input required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        <button>Add</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function History({ id }: { id: number }) {
  const { data } = useApi<{ events: { kind: string; fromLevel: number; toLevel: number; note: string; createdAt: string }[]; shifts: { startedAt: string; endedAt: string | null; autoEnded: boolean }[] }>(`/team/${id}/history`);
  if (!data) return <p className="muted small">Loading…</p>;
  return (
    <div className="grid g2" style={{ marginTop: 12 }}>
      <div>
        <h3>Level history</h3>
        {data.events.length === 0 ? <p className="muted small">Nothing yet.</p> : (
          <table><tbody>{data.events.map((e, i) => (
            <tr key={i}><td className="small">{shortDate(e.createdAt)}</td><td>{EVENT[e.kind] ?? e.kind}{e.toLevel && e.fromLevel !== e.toLevel ? ` (Level ${e.fromLevel} → ${e.toLevel})` : ''}{e.note && <div className="small muted">{e.note}</div>}</td></tr>
          ))}</tbody></table>
        )}
      </div>
      <div>
        <h3>Recent shifts</h3>
        {data.shifts.length === 0 ? <p className="muted small">No shifts logged.</p> : (
          <table><tbody>{data.shifts.slice(0, 8).map((s, i) => (
            <tr key={i}><td className="small">{dateTime(s.startedAt)}</td><td className="num small">
              {s.endedAt ? `${((new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()) / 3.6e6).toFixed(1)} h` : <span className="badge good">On shift</span>}
              {s.autoEnded && <span className="badge warn" style={{ marginLeft: 6 }}>Auto-ended</span>}
            </td></tr>
          ))}</tbody></table>
        )}
      </div>
    </div>
  );
}

function Card({ a, reload }: { a: Associate; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => { try { setErr(null); await fn(); reload(); } catch (e: any) { setErr(e.message); } };

  const cash = () => {
    const v = window.prompt(`How much cash did ${a.name} hand you?`, String(a.cashOwed));
    if (v) act(() => api.post(`/team/${a.id}/cash-received`, { amount: Number(v) }));
  };
  const password = () => {
    const v = window.prompt(`New password for ${a.name} (8+ characters)`);
    if (v) act(() => api.post(`/team/${a.id}/password`, { password: v }));
  };
  const target = a.periodTarget ?? 0;

  return (
    <div className="panel" style={{ opacity: a.active ? 1 : 0.55 }}>
      {a.pendingRemoval && (
        <div className="alert bad">
          {a.name} didn't reach Level 2 during the warning month. Your call:
          <div className="actions" style={{ marginTop: 8 }}>
            <button className="bad small" onClick={() => window.confirm(`Remove ${a.name}? Their login will stop working.`) && act(() => api.post(`/team/${a.id}/confirm-removal`))}>Remove {a.name.split(' ')[0]}</button>
            <button className="secondary small" onClick={() => act(() => api.post(`/team/${a.id}/keep`))}>Give another chance</button>
          </div>
        </div>
      )}
      {a.warningDeadline && !a.pendingRemoval && (
        <div className="alert warn">Warning: needs {a.jerseysToNextLevel} more jerseys by {shortDate(a.warningDeadline)} to reach Level 2.</div>
      )}
      <div className="panel-head">
        <div>
          <h2>{a.name}</h2>
          <div className="small muted">@{a.username} · joined {shortDate(a.joinedAt)}{!a.active && ' · removed'}</div>
        </div>
        <div className="actions">
          {a.onShiftSince && <span className="badge good">On shift since {dateTime(a.onShiftSince)}</span>}
          <LevelBadge level={a.level} />
        </div>
      </div>

      {a.nextLevel ? (
        <div style={{ marginBottom: 14 }}>
          <div className="actions small" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <span>{a.periodJerseys} / {target} jerseys this period</span>
            <span className="muted">Next check {shortDate(a.nextCheckAt)}{a.skipNextCheck ? ' (skipped: new)' : ''}</span>
          </div>
          <Progress value={a.periodJerseys} max={target} />
        </div>
      ) : (
        <p className="small muted">Top level. {a.periodJerseys} jerseys this period · next check {shortDate(a.nextCheckAt)}</p>
      )}

      <div className="grid g4">
        <div><div className="stat-label">Made for you</div><strong>{money(a.madeForYou)}</strong></div>
        <div><div className="stat-label">Commission owed</div><strong>{money(a.commissionUnpaid)}</strong><div className="small muted">{money(a.commissionEarned)} earned</div></div>
        <div><div className="stat-label">Cash they hold</div><strong>{money(a.cashOwed)}</strong></div>
        <div><div className="stat-label">Hours this month</div><strong>{a.hoursThisMonth} h</strong><div className="small muted">{a.hoursAllTime} h all time</div></div>
        <div><div className="stat-label">Jerseys sold</div><strong>{a.jerseysAllTime}</strong></div>
        <div><div className="stat-label">In hand</div><strong>{a.jerseysInHand}</strong>{a.jerseysOverdue > 0 && <div><span className="badge bad">{a.jerseysOverdue} overdue</span></div>}</div>
        <div><div className="stat-label">Next payout</div><strong>{a.setProgress} / {a.setSize}</strong></div>
        <div><div className="stat-label">Waiting approval</div><strong>{a.pendingSales}</strong></div>
      </div>

      {a.active && (
        <div className="actions" style={{ marginTop: 16 }}>
          <button className="secondary small" disabled={a.cashOwed <= 0} onClick={cash}>Record cash received</button>
          <button className="secondary small" onClick={password}>Reset password</button>
          <label className="check small"><input type="checkbox" checked={a.canSeeStock} onChange={(e) => act(() => api.patch(`/team/${a.id}`, { canSeeStock: e.target.checked }))} /> Can see stock</label>
          <button className="link small" onClick={() => setOpen((o) => !o)}>{open ? 'Hide history' : 'Show history'}</button>
        </div>
      )}
      {err && <p className="error">{err}</p>}
      {open && <History id={a.id} />}
    </div>
  );
}

export function Team() {
  const { data, error, reload } = useApi<Associate[]>('/team');
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHead title="Team" sub="Every associate's level, sales, hours, cash and commission.">
        <button onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ Add associate'}</button>
      </PageHead>
      {adding && <AddAssociate onDone={() => { setAdding(false); reload(); }} />}
      {!data ? <Loading error={error} /> : data.length === 0 ? <div className="panel empty">No associates yet.</div> : (
        <div className="stack">{data.map((a) => <Card key={a.id} a={a} reload={reload} />)}</div>
      )}
    </>
  );
}
