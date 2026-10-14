import { Link } from 'react-router-dom';
import { money, shortDate } from '../api';
import { useApi } from '../hooks';
import { LevelBadge, Loading, PageHead, Progress, Stat } from '../components/ui';
import { AnnouncementList, Announcement } from './Announcements';

interface Me {
  name: string; level: number; periodJerseys: number; setProgress: number; skipNextCheck: boolean;
  warningDeadline: string | null; jerseysAllTime: number; commissionEarned: number; commissionUnpaid: number;
  cashOwed: number; jerseysInHand: number; jerseysOverdue: number; pendingSales: number; hoursThisMonth: number;
  nextLevel: number | null; periodTarget: number | null; jerseysToNextLevel: number; nextCheckAt: string;
  jerseysToNextPayout: number; nextPayoutAmount: number; perJersey: number; setSize: number;
  nextMilestone: { jerseys: number; bonus: number } | null; jerseysToMilestone: number; milestonesAwarded: number;
  rules: { commissionPerSet: number[]; levelTargets: { level2: number; level3: number }; periodMonths: number; milestones: { jerseys: number; bonus: number }[] };
  recentEvents: { kind: string; fromLevel: number; toLevel: number; note: string; createdAt: string }[];
}

export function AssociateHome() {
  const { data: m, error } = useApi<Me>('/dashboard/me');
  const news = useApi<Announcement[]>('/announcements');
  if (!m) return <Loading error={error} />;
  const first = m.name.split(' ')[0];
  const levelUp = m.recentEvents.find((e) => e.kind === 'level_up' || e.kind === 'warning_cleared');
  const recentLevelUp = levelUp && Date.now() - new Date(levelUp.createdAt).getTime() < 7 * 864e5;

  return (
    <>
      <PageHead title={`Hey ${first}`} sub={<>You're <LevelBadge level={m.level} /> · {money(m.perJersey)} per jersey</>}>
        <Link to="/add-sale"><button>+ Add sale</button></Link>
      </PageHead>

      {m.warningDeadline && (
        <div className="alert bad">
          Warning: sell <strong>{m.jerseysToNextLevel} more jerseys</strong> by <strong>{shortDate(m.warningDeadline)}</strong> to reach Level 2 and keep your spot.
        </div>
      )}
      {recentLevelUp && !m.warningDeadline && (
        <div className="alert good">You're Level {levelUp!.toLevel} now. Every {m.setSize} jerseys pays {money(m.nextPayoutAmount)}.</div>
      )}
      {m.pendingSales > 0 && <div className="alert warn">{m.pendingSales} sale{m.pendingSales > 1 ? 's' : ''} waiting for Yassin to approve.</div>}

      <div className="grid g3">
        <div className="panel">
          <h2>Next payout</h2>
          <div className="dots" style={{ margin: '14px 0 10px' }}>
            {Array.from({ length: m.setSize }, (_, i) => <span key={i} className={i < m.setProgress ? 'on' : ''} />)}
          </div>
          <p><strong>{m.jerseysToNextPayout} more jersey{m.jerseysToNextPayout > 1 ? 's' : ''}</strong> to your next {money(m.nextPayoutAmount)}.</p>
        </div>
        <div className="panel">
          <h2>My level</h2>
          {m.nextLevel ? (
            <>
              <div className="actions small" style={{ justifyContent: 'space-between', margin: '14px 0 6px' }}>
                <span>{m.periodJerseys} / {m.periodTarget} jerseys</span><span className="muted">Level {m.nextLevel}</span>
              </div>
              <Progress value={m.periodJerseys} max={m.periodTarget ?? 1} />
              <p><strong>{m.jerseysToNextLevel} more</strong> to reach Level {m.nextLevel} ({money(m.rules.commissionPerSet[m.nextLevel - 1])} every {m.setSize}).</p>
            </>
          ) : <p style={{ marginTop: 14 }}>You're at the top level. {m.periodJerseys} jerseys this period.</p>}
          <p className="small muted">
            Next level check: {shortDate(m.nextCheckAt)}{m.skipNextCheck ? ' (your first one is skipped)' : ''}. At each check everyone drops one level, so keep selling.
          </p>
        </div>
        <div className="panel">
          <h2>Bonus</h2>
          {m.nextMilestone ? (
            <>
              <div className="actions small" style={{ justifyContent: 'space-between', margin: '14px 0 6px' }}>
                <span>{m.periodJerseys} / {m.nextMilestone.jerseys} jerseys</span><span className="muted">+{money(m.nextMilestone.bonus)}</span>
              </div>
              <Progress value={m.periodJerseys} max={m.nextMilestone.jerseys} />
              <p><strong>{m.jerseysToMilestone} more</strong> this period for a {money(m.nextMilestone.bonus)} bonus.</p>
            </>
          ) : <p style={{ marginTop: 14 }}>You've hit every bonus this period. Legend.</p>}
          <p className="small muted">Bonuses this period: {m.rules.milestones.map((x) => `${x.jerseys} jerseys = ${money(x.bonus)}`).join(' · ')}. They stack.</p>
        </div>
      </div>

      <div className="grid g3" style={{ marginTop: 16 }}>
        <Stat label="Earned (commission + bonuses)" value={money(m.commissionEarned)} note={<Link to="/payouts">{money(m.commissionUnpaid)} coming in your next payout</Link>} />
        <Stat label="Jerseys sold" value={m.jerseysAllTime} note="all time" />
        <Stat label="Hours this month" value={`${m.hoursThisMonth} h`} />
      </div>

      <div className="grid g2" style={{ marginTop: 16 }}>
        <div className="panel">
          <h2>Jerseys in hand</h2>
          <p style={{ fontSize: 28, fontFamily: 'Fraunces, serif', fontWeight: 700, margin: '8px 0' }}>{m.jerseysInHand}</p>
          {m.jerseysOverdue > 0 && <p><span className="badge bad">{m.jerseysOverdue} overdue</span> Return them to Yassin or sell them.</p>}
          <Link className="small" to="/stock">See which ones</Link>
        </div>
        <div className="panel">
          <h2>Cash you're holding</h2>
          <p style={{ fontSize: 28, fontFamily: 'Fraunces, serif', fontWeight: 700, margin: '8px 0' }}>{money(m.cashOwed)}</p>
          <p className="small muted">Hand this to Yassin. He'll mark it as received.</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Announcements</h2><Link className="small" to="/announcements">All</Link></div>
        {news.data ? <AnnouncementList items={news.data.slice(0, 3)} /> : <p className="muted">Loading…</p>}
      </div>
    </>
  );
}
