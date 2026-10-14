import { Router } from 'express';
import { pool } from '../db/pool.js';
import { me } from '../auth.js';
import { HttpError } from '../services/sales.js';
import { autoEndShifts } from '../services/jobs.js';
import { getSettings } from '../services/settings.js';

// Shift Timer: Start / End buttons and total hours.
export const shiftRoutes = Router();

shiftRoutes.get('/shifts/me', async (req, res) => {
  await autoEndShifts();
  const uid = me(req).id;
  const hours = (from: string) =>
    `COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)) / 3600) FILTER (WHERE started_at >= ${from}), 0)`;
  const [list, totals] = await Promise.all([
    pool.query(`SELECT id, started_at AS "startedAt", ended_at AS "endedAt", auto_ended AS "autoEnded" FROM shifts WHERE user_id = $1 ORDER BY started_at DESC LIMIT 50`, [uid]),
    pool.query(
      `SELECT ${hours("date_trunc('week', now())")} AS week, ${hours("date_trunc('month', now())")} AS month,
              ${hours("'-infinity'")} AS "allTime"
         FROM shifts WHERE user_id = $1`,
      [uid],
    ),
  ]);
  const round = (n: number) => Math.round(n * 10) / 10;
  const t = totals.rows[0];
  res.json({
    open: list.rows.find((s) => !s.endedAt) ?? null,
    shifts: list.rows,
    totals: { week: round(t.week), month: round(t.month), allTime: round(t.allTime) },
    maxHours: (await getSettings(pool)).shiftMaxHours,
  });
});

shiftRoutes.post('/shifts/start', async (req, res) => {
  try {
    await pool.query(`INSERT INTO shifts (user_id) VALUES ($1)`, [me(req).id]);
  } catch (e: any) {
    if (e.code === '23505') throw new HttpError(409, 'You already have a shift running');
    throw e;
  }
  res.status(201).json({ ok: true });
});

shiftRoutes.post('/shifts/end', async (req, res) => {
  const r = await pool.query(`UPDATE shifts SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL`, [me(req).id]);
  if (!r.rowCount) throw new HttpError(409, 'No shift is running');
  res.json({ ok: true });
});
