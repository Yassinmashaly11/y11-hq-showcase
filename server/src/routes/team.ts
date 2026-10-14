import { NextFunction, Request, Response, Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { me, requireOwner } from '../auth.js';
import { HttpError } from '../services/sales.js';
import { getSettings } from '../services/settings.js';
import { associateStats } from '../services/stats.js';
import { logActivity } from '../services/activity.js';
import { autoEndShifts } from '../services/jobs.js';

// Team: CEO only.
export const teamRoutes = Router();
teamRoutes.use('/team', requireOwner);

// On the public recruiter demo, nobody can lock the one-click demo logins out for everyone else.
const notInDemo = (what: string) => (_req: Request, _res: Response, next: NextFunction) => {
  if (process.env.DEMO_MODE === 'true') throw new HttpError(403, `${what} is turned off in the demo.`);
  next();
};
const id = (v: unknown) => z.coerce.number().int().positive().parse(v);

teamRoutes.get('/team', async (_req, res) => {
  await autoEndShifts();
  res.json(await associateStats(pool, await getSettings(pool)));
});

const NewAssociate = z.object({
  fullName: z.string().trim().min(1),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,30}$/, 'Username: 3-30 letters, numbers, . _ -'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

teamRoutes.post('/team', async (req, res) => {
  const b = NewAssociate.parse(req.body);
  const hash = await bcrypt.hash(b.password, 10);
  try {
    const r = await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role, referral_code) VALUES ($1,$2,$3,'associate',$1) RETURNING id`,
      [b.username, hash, b.fullName],
    );
    await logActivity(pool, me(req).id, 'associate_added', { associateId: r.rows[0].id, name: b.fullName });
    res.status(201).json({ id: r.rows[0].id });
  } catch (e: any) {
    if (e.code === '23505') throw new HttpError(409, 'That username is taken');
    throw e;
  }
});

teamRoutes.patch('/team/:id', async (req, res) => {
  const b = z.object({ canSeeStock: z.boolean() }).parse(req.body);
  await pool.query(`UPDATE users SET can_see_stock = $2 WHERE id = $1 AND role = 'associate'`, [id(req.params.id), b.canSeeStock]);
  res.json({ ok: true });
});

teamRoutes.post('/team/:id/password', notInDemo('Resetting passwords'), async (req, res) => {
  const b = z.object({ password: z.string().min(8, 'Password must be at least 8 characters') }).parse(req.body);
  await pool.query(`UPDATE users SET password_hash = $2 WHERE id = $1 AND role = 'associate'`, [id(req.params.id), await bcrypt.hash(b.password, 10)]);
  await logActivity(pool, me(req).id, 'password_reset', { associateId: id(req.params.id) });
  res.json({ ok: true });
});

// The associate handed you cash.
teamRoutes.post('/team/:id/cash-received', async (req, res) => {
  const b = z.object({ amount: z.number().positive() }).parse(req.body);
  const aid = id(req.params.id);
  await pool.query(`INSERT INTO cash_ledger (associate_id, amount, note) VALUES ($1, $2, 'Handed to CEO')`, [aid, -b.amount]);
  await logActivity(pool, me(req).id, 'cash_received', { associateId: aid, amount: b.amount });
  res.json({ ok: true });
});

// Missed the warning month: the CEO makes the final call.
teamRoutes.post('/team/:id/confirm-removal', notInDemo('Removing associates'), async (req, res) => {
  const aid = id(req.params.id);
  await tx(async (c) => {
    await c.query(`UPDATE users SET active = FALSE, removed_at = now(), pending_removal = FALSE WHERE id = $1 AND role = 'associate'`, [aid]);
    await c.query(`UPDATE shifts SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL`, [aid]);
    await c.query(`INSERT INTO level_events (associate_id, kind, note) VALUES ($1, 'removed', 'Removed by CEO')`, [aid]);
    await logActivity(c, me(req).id, 'associate_removed', { associateId: aid });
  });
  res.json({ ok: true });
});

// The CEO decides to give them another chance: clear the warning and start a fresh period at Level 1.
teamRoutes.post('/team/:id/keep', async (req, res) => {
  const aid = id(req.params.id);
  await tx(async (c) => {
    await c.query(
      `UPDATE users SET pending_removal = FALSE, warning_deadline = NULL, period_start = now(), period_jerseys = 0
        WHERE id = $1 AND role = 'associate'`,
      [aid],
    );
    await c.query(`INSERT INTO level_events (associate_id, kind, note) VALUES ($1, 'kept', 'CEO gave another chance')`, [aid]);
    await logActivity(c, me(req).id, 'associate_kept', { associateId: aid });
  });
  res.json({ ok: true });
});

teamRoutes.get('/team/:id/history', async (req, res) => {
  const aid = id(req.params.id);
  const [events, shifts] = await Promise.all([
    pool.query(`SELECT kind, from_level AS "fromLevel", to_level AS "toLevel", note, created_at AS "createdAt"
                  FROM level_events WHERE associate_id = $1 ORDER BY created_at DESC LIMIT 50`, [aid]),
    pool.query(`SELECT started_at AS "startedAt", ended_at AS "endedAt", auto_ended AS "autoEnded" FROM shifts WHERE user_id = $1 ORDER BY started_at DESC LIMIT 30`, [aid]),
  ]);
  res.json({ events: events.rows, shifts: shifts.rows });
});
