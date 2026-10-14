import pg from 'pg';
import { pool, tx } from '../db/pool.js';
import { AssociateState, Earning, LevelEvent, runCheck } from '../domain/levels.js';
import { getSettings } from './settings.js';
import { logActivity } from './activity.js';
import { notify, notifyOwner } from './notify.js';

// Loads and saves the level state of one associate. FOR UPDATE locks the row so two
// sales approved at the same moment cannot both read the old count.
export async function loadState(c: pg.PoolClient, id: number): Promise<AssociateState> {
  const r = await c.query(
    `SELECT level, period_start, period_jerseys, set_progress, skip_next_check, warning_deadline, pending_removal,
            milestones_awarded FROM users WHERE id = $1 AND role = 'associate' FOR UPDATE`,
    [id],
  );
  if (!r.rows[0]) throw new Error(`Associate ${id} not found`);
  const u = r.rows[0];
  return {
    level: u.level,
    periodStart: u.period_start,
    periodJerseys: u.period_jerseys,
    setProgress: u.set_progress,
    skipNextCheck: u.skip_next_check,
    warningDeadline: u.warning_deadline,
    pendingRemoval: u.pending_removal,
    milestonesAwarded: u.milestones_awarded,
  };
}

export async function saveState(c: pg.PoolClient, id: number, st: AssociateState) {
  await c.query(
    `UPDATE users SET level = $2, period_start = $3, period_jerseys = $4, set_progress = $5,
       skip_next_check = $6, warning_deadline = $7, pending_removal = $8, milestones_awarded = $9 WHERE id = $1`,
    [id, st.level, st.periodStart, st.periodJerseys, st.setProgress, st.skipNextCheck, st.warningDeadline, st.pendingRemoval, st.milestonesAwarded],
  );
}

const MESSAGES: Record<string, (e: LevelEvent) => string> = {
  level_up: (e) => `You're Level ${e.toLevel} now! Your payout per set went up.`,
  warning_cleared: (e) => `You made it to Level ${e.toLevel}. Warning cleared and a new 2-month period has started.`,
  period_drop: (e) => `2-month check: you dropped to Level ${e.toLevel}. Sell to climb back up.`,
  warning: (e) => `Warning: ${e.note}.`,
  removal_flag: () => `Your warning month ended without reaching Level 2. Yassin will be in touch.`,
  milestone: (e) => `Bonus! ${e.note}`,
};

export async function recordEvents(c: pg.PoolClient, id: number, events: LevelEvent[], at: Date) {
  const name = (await c.query(`SELECT full_name FROM users WHERE id = $1`, [id])).rows[0]?.full_name ?? 'An associate';
  for (const e of events) {
    await c.query(
      `INSERT INTO level_events (associate_id, kind, from_level, to_level, note, created_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, e.kind, e.fromLevel, e.toLevel, e.note ?? null, at],
    );
    const msg = MESSAGES[e.kind];
    if (msg) await notify(c, id, e.kind, msg(e), '/');
    if (e.kind === 'level_up') await notifyOwner(c, 'level_up', `${name} reached Level ${e.toLevel}.`, '/team');
    if (e.kind === 'warning') await notifyOwner(c, 'warning', `${name} is at Level 1 and has been warned.`, '/team');
    if (e.kind === 'removal_flag') await notifyOwner(c, 'removal_flag', `${name} missed the warning deadline. Decide in Team.`, '/team');
    if (e.kind === 'milestone') await notifyOwner(c, 'milestone', `${name}: ${e.note}`, '/payouts');
  }
}

export async function recordEarnings(c: pg.PoolClient, id: number, saleId: number, earnings: Earning[], at: Date) {
  for (const e of earnings) {
    await c.query(
      `INSERT INTO commission_earnings (associate_id, sale_id, amount, level, kind, note, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, saleId, e.amount, e.level, e.kind, e.note ?? null, at],
    );
  }
}

/** Runs the 2-month check for every active associate. Called hourly and from the CEO's Settings page. */
export async function runLevelChecks(now = new Date()) {
  const s = await getSettings(pool);
  const ids = (await pool.query(`SELECT id FROM users WHERE role = 'associate' AND active`)).rows.map((r) => r.id);
  const changed: { associateId: number; events: LevelEvent[] }[] = [];
  for (const id of ids) {
    await tx(async (c) => {
      const before = await loadState(c, id);
      const { state, events } = runCheck(before, now, s);
      if (events.length === 0) return;
      await saveState(c, id, state);
      await recordEvents(c, id, events, now);
      await logActivity(c, null, 'level_check', { associateId: id, events });
      changed.push({ associateId: id, events });
    });
  }
  return changed;
}
