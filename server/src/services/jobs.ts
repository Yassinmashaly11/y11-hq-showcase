import { pool } from '../db/pool.js';
import { getSettings } from './settings.js';
import { notify, notifyOwner } from './notify.js';
import { runLevelChecks } from './levels.js';

/**
 * Shifts left running past the limit (10 hours by default) are closed at exactly the limit
 * and marked "auto-ended", so a forgotten End button can't inflate anyone's hours.
 */
export async function autoEndShifts(now = new Date()) {
  const s = await getSettings(pool);
  const r = await pool.query(
    `UPDATE shifts SET ended_at = started_at + make_interval(hours => $1), auto_ended = TRUE
      WHERE ended_at IS NULL AND started_at + make_interval(hours => $1) <= $2
      RETURNING user_id, started_at`,
    [s.shiftMaxHours, now],
  );
  for (const row of r.rows) {
    await notify(pool, row.user_id, 'shift_auto_ended', `Your shift was ended automatically after ${s.shiftMaxHours} hours. Remember to press End shift.`, '/shift');
    const name = (await pool.query(`SELECT full_name FROM users WHERE id = $1`, [row.user_id])).rows[0]?.full_name;
    await notifyOwner(pool, 'shift_auto_ended', `${name}'s shift was auto-ended after ${s.shiftMaxHours} hours.`, '/team');
  }
  return r.rowCount ?? 0;
}

/** In-hand jerseys past their due date: tell the associate and the CEO once. Ones waiting for the CEO don't count. */
export async function notifyOverdueInHand() {
  const r = await pool.query(
    `UPDATE in_hand h SET overdue_notified = TRUE
       FROM variants v, products p, users u
      WHERE v.id = h.variant_id AND p.id = v.product_id AND u.id = h.associate_id
        AND h.quantity > 0 AND h.due_at < now() AND NOT h.overdue_notified
        AND NOT EXISTS (SELECT 1 FROM in_hand_updates r WHERE r.in_hand_id = h.id AND r.status = 'pending')
      RETURNING h.associate_id, u.full_name, p.team, p.kit, v.size`,
  );
  for (const row of r.rows) {
    await notify(pool, row.associate_id, 'in_hand_overdue', `${row.team} ${row.kit} (${row.size}) is overdue. Sell it or return it to Yassin.`, '/stock');
    await notifyOwner(pool, 'in_hand_overdue', `${row.full_name} still has ${row.team} ${row.kit} (${row.size}) past its due date.`, '/inventory');
  }
}

/** Everything that runs on a timer. Safe to run as often as you like. */
export async function runScheduledJobs(now = new Date()) {
  await autoEndShifts(now);
  await notifyOverdueInHand();
  await runLevelChecks(now);
}
