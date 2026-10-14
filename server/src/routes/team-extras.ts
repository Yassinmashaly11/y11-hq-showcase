import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { me, requireOwner } from '../auth.js';
import { HttpError } from '../services/sales.js';
import { notify, notifyTeam } from '../services/notify.js';
import { logActivity } from '../services/activity.js';
import { getSettings } from '../services/settings.js';

// Leaderboard, promo codes & referral links, announcements, notifications.
export const teamExtraRoutes = Router();
const id = (v: unknown) => z.coerce.number().int().positive().parse(v);
const SITE_URL = () => process.env.SITE_URL ?? 'https://www.y11jerseys.com';

/** Jerseys sold per person between two dates (approved sales only), including the CEO's own sales. */
async function standings(from: Date | string, to: Date | string) {
  const r = await pool.query(
    `SELECT u.id, u.full_name AS name, u.level, u.role, COALESCE(SUM(s.jersey_count), 0) AS jerseys
       FROM users u
       LEFT JOIN sales s ON s.status = 'approved' AND s.decided_at >= $1 AND s.decided_at < $2
            AND (s.associate_id = u.id OR (u.role = 'owner' AND s.associate_id IS NULL AND s.channel = 'owner'))
      WHERE (u.role = 'associate' AND u.active) OR u.role = 'owner'
      GROUP BY u.id ORDER BY jerseys DESC, u.full_name`,
    [from, to],
  );
  return rank(r.rows);
}

/** Same jerseys = same rank (1, 2, 2, 4). */
function rank<T extends { jerseys: number }>(rows: T[]) {
  let place = 0, last = -1;
  return rows.map((row, i) => {
    if (row.jerseys !== last) { place = i + 1; last = row.jerseys; }
    return { ...row, rank: place };
  });
}

// ---------- Leaderboard ----------

teamExtraRoutes.get('/leaderboard', async (req, res) => {
  const range = z.enum(['week', 'month', 'period', 'all']).catch('month').parse(req.query.range);
  const u = me(req);
  let rows;
  if (range === 'period') {
    // Associates: their own current 2-month period (the one that decides their level).
    // The CEO has no levels, so it's your sales over the same length of time.
    const months = (await getSettings(pool)).periodMonths;
    rows = rank((await pool.query(
      `SELECT id, full_name AS name, level, role, period_jerseys AS jerseys FROM users WHERE role = 'associate' AND active
       UNION ALL
       SELECT u.id, u.full_name, u.level, u.role,
              (SELECT COALESCE(SUM(jersey_count), 0)::int FROM sales
                WHERE status = 'approved' AND associate_id IS NULL AND channel = 'owner'
                  AND decided_at >= now() - make_interval(months => $1))
         FROM users u WHERE u.role = 'owner'
       ORDER BY jerseys DESC, name`,
      [months],
    )).rows);
  } else {
    const from = (await pool.query(
      `SELECT ${range === 'week' ? "date_trunc('week', now())" : range === 'month' ? "date_trunc('month', now())" : "'-infinity'::timestamptz"} AS f`,
    )).rows[0].f;
    rows = await standings(from, 'infinity');
  }
  res.json(rows.map((r) => ({ ...r, isMe: r.id === u.id })));
});

// ---------- Promo codes & referral links ----------

teamExtraRoutes.get('/promo-codes', async (req, res) => {
  const u = me(req);
  const codes = await pool.query(
    `SELECT c.id, c.code, c.active, c.created_at AS "createdAt", c.associate_id AS "associateId", a.full_name AS "associateName",
            (SELECT COUNT(*) FROM sales s WHERE s.promo_code = c.code AND s.status = 'approved') AS uses
       FROM promo_codes c JOIN users a ON a.id = c.associate_id
      ${u.role === 'owner' ? '' : 'WHERE c.associate_id = $1'}
      ORDER BY a.full_name, c.created_at`,
    u.role === 'owner' ? [] : [u.id],
  );
  const links = await pool.query(
    `SELECT id, full_name AS name, referral_code AS "referralCode" FROM users
      WHERE role = 'associate' AND active ${u.role === 'owner' ? '' : 'AND id = $1'} ORDER BY full_name`,
    u.role === 'owner' ? [] : [u.id],
  );
  res.json({
    codes: codes.rows,
    links: links.rows.map((l) => ({ ...l, url: l.referralCode ? `${SITE_URL()}/?ref=${l.referralCode}` : null })),
  });
});

const CODE = z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,20}$/, 'Codes are 3-20 letters, numbers, - or _');

teamExtraRoutes.post('/promo-codes', requireOwner, async (req, res) => {
  const b = z.object({ associateId: z.number().int(), code: CODE }).parse(req.body);
  try {
    await pool.query(`INSERT INTO promo_codes (associate_id, code) VALUES ($1, $2)`, [b.associateId, b.code]);
  } catch (e: any) {
    if (e.code === '23505') throw new HttpError(409, `${b.code} is already taken`);
    throw e;
  }
  await notify(pool, b.associateId, 'promo_code', `You have a new promo code: ${b.code}`, '/links');
  await logActivity(pool, me(req).id, 'promo_code_added', b);
  res.status(201).json({ ok: true });
});

teamExtraRoutes.patch('/promo-codes/:id', requireOwner, async (req, res) => {
  const b = z.object({ active: z.boolean() }).parse(req.body);
  await pool.query(`UPDATE promo_codes SET active = $2 WHERE id = $1`, [id(req.params.id), b.active]);
  res.json({ ok: true });
});

teamExtraRoutes.put('/team/:id/referral', requireOwner, async (req, res) => {
  const b = z.object({ referralCode: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{3,20}$/, 'Use 3-20 letters, numbers, - or _') }).parse(req.body);
  try {
    await pool.query(`UPDATE users SET referral_code = $2 WHERE id = $1 AND role = 'associate'`, [id(req.params.id), b.referralCode]);
  } catch (e: any) {
    if (e.code === '23505') throw new HttpError(409, 'That link is already taken');
    throw e;
  }
  res.json({ ok: true });
});

// ---------- Announcements ----------

teamExtraRoutes.get('/announcements', async (_req, res) => {
  const r = await pool.query(
    `SELECT a.id, a.title, a.body, a.pinned, a.created_at AS "createdAt", u.full_name AS "author"
       FROM announcements a JOIN users u ON u.id = a.created_by ORDER BY a.pinned DESC, a.created_at DESC LIMIT 30`,
  );
  res.json(r.rows);
});

teamExtraRoutes.post('/announcements', requireOwner, async (req, res) => {
  const b = z.object({ title: z.string().trim().min(1), body: z.string().trim().min(1).max(2000), pinned: z.boolean().default(false) }).parse(req.body);
  await pool.query(`INSERT INTO announcements (title, body, pinned, created_by) VALUES ($1,$2,$3,$4)`, [b.title, b.body, b.pinned, me(req).id]);
  await notifyTeam(pool, 'announcement', `New announcement: ${b.title}`, '/');
  res.status(201).json({ ok: true });
});

teamExtraRoutes.delete('/announcements/:id', requireOwner, async (req, res) => {
  await pool.query(`DELETE FROM announcements WHERE id = $1`, [id(req.params.id)]);
  res.json({ ok: true });
});

// ---------- Notifications (the bell) ----------

teamExtraRoutes.get('/notifications', async (req, res) => {
  const uid = me(req).id;
  const [list, unread] = await Promise.all([
    pool.query(`SELECT id, kind, message, link, created_at AS "createdAt", read_at IS NOT NULL AS read
                  FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30`, [uid]),
    pool.query(`SELECT COUNT(*) n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [uid]),
  ]);
  res.json({ unread: unread.rows[0].n, items: list.rows });
});

teamExtraRoutes.post('/notifications/read-all', async (req, res) => {
  await pool.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [me(req).id]);
  res.json({ ok: true });
});
