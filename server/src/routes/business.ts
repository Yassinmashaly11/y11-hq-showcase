import { Router, Response } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { me, requireOwner } from '../auth.js';
import { logActivity } from '../services/activity.js';
import { LOST_JERSEY_EXPENSE } from '../services/in-hand.js';

// CEO only: expenses, customers, activity log, spreadsheet exports.
export const businessRoutes = Router();
businessRoutes.use(['/expenses', '/customers', '/activity', '/reports'], requireOwner);
const id = (v: unknown) => z.coerce.number().int().positive().parse(v);

// ---------- Expenses ----------

export const EXPENSE_CATEGORIES = ['Ads', 'Packaging', 'Website & domain', 'Payment fees', 'Shipping', 'Supplies', LOST_JERSEY_EXPENSE, 'Other'];

businessRoutes.get('/expenses', async (_req, res) => {
  const [list, byCategory] = await Promise.all([
    pool.query(`SELECT e.id, e.category, e.description, e.amount, to_char(e.spent_at, 'YYYY-MM-DD') AS "spentAt"
                  FROM expenses e ORDER BY e.spent_at DESC, e.id DESC LIMIT 300`),
    pool.query(`SELECT category, SUM(amount) total FROM expenses WHERE spent_at >= date_trunc('month', now()) GROUP BY category ORDER BY total DESC`),
  ]);
  res.json({ categories: EXPENSE_CATEGORIES, items: list.rows, thisMonth: byCategory.rows });
});

businessRoutes.post('/expenses', async (req, res) => {
  const b = z.object({
    category: z.enum(EXPENSE_CATEGORIES as [string, ...string[]]),
    description: z.string().trim().max(200).optional(),
    amount: z.number().positive(),
    spentAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).parse(req.body);
  await pool.query(
    `INSERT INTO expenses (category, description, amount, spent_at, created_by) VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5)`,
    [b.category, b.description ?? null, b.amount, b.spentAt ?? null, me(req).id],
  );
  await logActivity(pool, me(req).id, 'expense_added', b);
  res.status(201).json({ ok: true });
});

businessRoutes.delete('/expenses/:id', async (req, res) => {
  await pool.query(`DELETE FROM expenses WHERE id = $1`, [id(req.params.id)]);
  await logActivity(pool, me(req).id, 'expense_deleted', { expenseId: id(req.params.id) });
  res.json({ ok: true });
});

// ---------- Customers (built from sales; matched by email, else by name) ----------

businessRoutes.get('/customers', async (_req, res) => {
  const r = await pool.query(
    `SELECT (array_agg(s.customer_name ORDER BY s.created_at DESC))[1] AS name,
            (array_agg(s.customer_email ORDER BY s.created_at DESC) FILTER (WHERE s.customer_email IS NOT NULL))[1] AS email,
            COUNT(*) AS orders, SUM(s.jersey_count) AS jerseys, SUM(s.revenue + s.shipping) AS spent,
            MIN(s.decided_at) AS "firstOrder", MAX(s.decided_at) AS "lastOrder",
            string_agg(DISTINCT COALESCE(a.full_name, 'You'), ', ') AS "soldBy"
       FROM sales s LEFT JOIN users a ON a.id = s.associate_id
      WHERE s.status = 'approved'
      GROUP BY lower(COALESCE(s.customer_email, s.customer_name))
      ORDER BY spent DESC LIMIT 500`,
  );
  const rows = r.rows;
  res.json({
    customers: rows,
    total: rows.length,
    repeat: rows.filter((c) => c.orders > 1).length,
  });
});

// ---------- Activity log ----------

businessRoutes.get('/activity', async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(500).catch(150).parse(req.query.limit);
  const r = await pool.query(
    `SELECT l.id, l.action, l.details, l.created_at AS "createdAt", COALESCE(u.full_name, 'Y11 HQ (automatic)') AS actor
       FROM activity_log l LEFT JOIN users u ON u.id = l.actor_id
      WHERE l.action <> 'login' OR $2::boolean
      ORDER BY l.created_at DESC LIMIT $1`,
    [limit, req.query.logins === 'true'],
  );
  const people = (await pool.query(`SELECT id, full_name FROM users`)).rows;
  res.json({ entries: r.rows, people: Object.fromEntries(people.map((p) => [p.id, p.full_name])) });
});

// ---------- Reports: CSV downloads that open in Excel / Google Sheets ----------

function csv(res: Response, filename: string, rows: Record<string, unknown>[]) {
  const cols = rows.length ? Object.keys(rows[0]) : ['empty'];
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

const Range = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).catch('2000-01-01'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).catch('2999-12-31'),
});

businessRoutes.get('/reports/:kind', async (req, res) => {
  const kind = z.enum(['sales', 'commissions', 'hours', 'expenses']).parse(String(req.params.kind).replace(/\.csv$/, ''));
  const { from, to } = Range.parse(req.query);
  const p = [from, to];
  const name = `y11-${kind}-${from}-to-${to}.csv`;

  if (kind === 'sales') {
    const r = await pool.query(
      `SELECT s.id AS order_id, to_char(s.decided_at, 'YYYY-MM-DD') AS date, COALESCE(a.full_name, 'CEO') AS sold_by,
              s.channel, s.payment_method, s.customer_name, s.customer_email, s.jersey_count AS jerseys,
              s.revenue, s.shipping, s.cost, s.profit, s.squad_deal, s.whatsapp_discount
         FROM sales s LEFT JOIN users a ON a.id = s.associate_id
        WHERE s.status = 'approved' AND s.decided_at::date BETWEEN $1 AND $2 ORDER BY s.decided_at`, p);
    return csv(res, name, r.rows);
  }
  if (kind === 'commissions') {
    const r = await pool.query(
      `SELECT to_char(e.created_at, 'YYYY-MM-DD') AS date, a.full_name AS associate, e.kind, e.level, e.amount, e.note,
              e.sale_id, to_char(e.paid_at, 'YYYY-MM-DD') AS paid_on, e.payout_id
         FROM commission_earnings e JOIN users a ON a.id = e.associate_id
        WHERE e.created_at::date BETWEEN $1 AND $2 ORDER BY e.created_at`, p);
    return csv(res, name, r.rows);
  }
  if (kind === 'hours') {
    const r = await pool.query(
      `SELECT u.full_name AS person, to_char(s.started_at, 'YYYY-MM-DD HH24:MI') AS started,
              to_char(s.ended_at, 'YYYY-MM-DD HH24:MI') AS ended,
              ROUND((EXTRACT(EPOCH FROM (COALESCE(s.ended_at, now()) - s.started_at)) / 3600)::numeric, 2) AS hours,
              s.auto_ended
         FROM shifts s JOIN users u ON u.id = s.user_id
        WHERE s.started_at::date BETWEEN $1 AND $2 ORDER BY s.started_at`, p);
    return csv(res, name, r.rows);
  }
  const r = await pool.query(
    `SELECT to_char(spent_at, 'YYYY-MM-DD') AS date, category, description, amount FROM expenses
      WHERE spent_at BETWEEN $1 AND $2 ORDER BY spent_at`, p);
  return csv(res, name, r.rows);
});
