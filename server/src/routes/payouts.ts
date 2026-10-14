import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { me, requireOwner } from '../auth.js';
import { HttpError } from '../services/sales.js';
import { notify } from '../services/notify.js';
import { logActivity } from '../services/activity.js';

// Payouts: what you owe each associate, paying it, and the statement for every payout.
export const payoutRoutes = Router();
const id = (v: unknown) => z.coerce.number().int().positive().parse(v);

const EARNING_COLUMNS = `
  e.id, e.kind, e.level, e.amount, e.note, e.created_at AS "earnedAt", e.paid_at AS "paidAt", e.payout_id AS "payoutId",
  s.id AS "saleId", s.customer_name AS "customerName", s.jersey_count AS "saleJerseys"`;

// CEO: everyone you owe money to right now
payoutRoutes.get('/payouts/summary', requireOwner, async (_req, res) => {
  const r = await pool.query(
    `SELECT u.id, u.full_name AS name, u.active,
            SUM(e.amount) AS owed,
            SUM(e.amount) FILTER (WHERE e.kind = 'commission') AS commission,
            SUM(e.amount) FILTER (WHERE e.kind <> 'commission') AS bonuses,
            COUNT(*) AS items, MIN(e.created_at) AS "oldest"
       FROM commission_earnings e JOIN users u ON u.id = e.associate_id
      WHERE e.paid_at IS NULL
      GROUP BY u.id ORDER BY owed DESC`,
  );
  res.json(r.rows.map((x) => ({ ...x, commission: x.commission ?? 0, bonuses: x.bonuses ?? 0 })));
});

// Unpaid earnings (CEO: ?associateId=, associate: their own)
payoutRoutes.get('/earnings/unpaid', async (req, res) => {
  const u = me(req);
  const aid = u.role === 'owner' ? id(req.query.associateId) : u.id;
  const r = await pool.query(
    `SELECT ${EARNING_COLUMNS} FROM commission_earnings e LEFT JOIN sales s ON s.id = e.sale_id
      WHERE e.associate_id = $1 AND e.paid_at IS NULL ORDER BY e.created_at DESC`,
    [aid],
  );
  res.json(r.rows);
});

// Payout history (CEO: everyone, associate: their own)
payoutRoutes.get('/payouts', async (req, res) => {
  const u = me(req);
  const r = await pool.query(
    `SELECT p.id, p.associate_id AS "associateId", a.full_name AS "associateName", p.amount, p.method, p.note, p.paid_at AS "paidAt",
            (SELECT COUNT(*) FROM commission_earnings e WHERE e.payout_id = p.id) AS items
       FROM payouts p JOIN users a ON a.id = p.associate_id
      ${u.role === 'owner' ? '' : 'WHERE p.associate_id = $1'}
      ORDER BY p.paid_at DESC LIMIT 100`,
    u.role === 'owner' ? [] : [u.id],
  );
  res.json(r.rows);
});

// Commission statement: one payout and every line it covers
payoutRoutes.get('/payouts/:id', async (req, res) => {
  const u = me(req);
  const pid = id(req.params.id);
  const p = (await pool.query(
    `SELECT p.id, p.associate_id AS "associateId", a.full_name AS "associateName", p.amount, p.method, p.note, p.paid_at AS "paidAt"
       FROM payouts p JOIN users a ON a.id = p.associate_id WHERE p.id = $1`,
    [pid],
  )).rows[0];
  if (!p || (u.role !== 'owner' && p.associateId !== u.id)) throw new HttpError(404, 'Statement not found');
  const lines = await pool.query(
    `SELECT ${EARNING_COLUMNS} FROM commission_earnings e LEFT JOIN sales s ON s.id = e.sale_id
      WHERE e.payout_id = $1 ORDER BY e.created_at`,
    [pid],
  );
  res.json({ ...p, lines: lines.rows });
});

// CEO pays an associate everything they're owed
const PayBody = z.object({
  associateId: z.number().int(),
  method: z.enum(['etransfer', 'cash', 'other']).default('etransfer'),
  note: z.string().trim().max(200).optional(),
});

payoutRoutes.post('/payouts', requireOwner, async (req, res) => {
  const b = PayBody.parse(req.body);
  const payout = await tx(async (c) => {
    const unpaid = await c.query(
      `SELECT id, amount FROM commission_earnings WHERE associate_id = $1 AND paid_at IS NULL FOR UPDATE`,
      [b.associateId],
    );
    if (!unpaid.rowCount) throw new HttpError(400, 'Nothing is owed to this associate');
    const amount = Math.round(unpaid.rows.reduce((n, r) => n + r.amount, 0) * 100) / 100;
    const p = await c.query(
      `INSERT INTO payouts (associate_id, amount, method, note, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, paid_at`,
      [b.associateId, amount, b.method, b.note ?? null, me(req).id],
    );
    await c.query(
      `UPDATE commission_earnings SET paid_at = $2, payout_id = $3 WHERE id = ANY($1)`,
      [unpaid.rows.map((r) => r.id), p.rows[0].paid_at, p.rows[0].id],
    );
    await notify(c, b.associateId, 'payout', `You were paid $${amount}. Your statement is ready.`, '/payouts');
    await logActivity(c, me(req).id, 'payout_made', { associateId: b.associateId, amount, payoutId: p.rows[0].id });
    return { id: p.rows[0].id, amount };
  });
  res.status(201).json(payout);
});
