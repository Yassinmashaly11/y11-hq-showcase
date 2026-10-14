import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { me, requireOwner } from '../auth.js';
import { getSettings } from '../services/settings.js';
import { associateStats } from '../services/stats.js';

export const dashboardRoutes = Router();

const RANGES = {
  today: "date_trunc('day', now())",
  week: "date_trunc('week', now())",
  month: "date_trunc('month', now())",
  all: "'-infinity'::timestamptz",
} as const;

// CEO Dashboard: revenue first, then profit, jerseys, channels, team, alerts.
dashboardRoutes.get('/dashboard/owner', requireOwner, async (req, res) => {
  const range = z.enum(['today', 'week', 'month', 'all']).catch('month').parse(req.query.range);
  const from = RANGES[range];
  const s = await getSettings(pool);

  const [totals, channels, daily, commission, pending, lowStock, owed, inHand, expenses] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(revenue),0) revenue, COALESCE(SUM(profit),0) profit, COALESCE(SUM(jersey_count),0) jerseys,
                       COUNT(*) orders FROM sales WHERE status = 'approved' AND decided_at >= ${from}`),
    pool.query(`SELECT channel, COALESCE(SUM(revenue),0) revenue, COALESCE(SUM(jersey_count),0) jerseys
                  FROM sales WHERE status = 'approved' AND decided_at >= ${from} GROUP BY channel`),
    pool.query(`SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(SUM(s.revenue),0) revenue, COALESCE(SUM(s.profit),0) profit
                  FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') d
                  LEFT JOIN sales s ON s.status = 'approved' AND date_trunc('day', s.decided_at) = d
                 GROUP BY d ORDER BY d`),
    pool.query(`SELECT COALESCE(SUM(amount),0) total FROM commission_earnings WHERE created_at >= ${from}`),
    pool.query(`SELECT (SELECT COUNT(*) FROM sales WHERE status = 'pending') sales,
                       (SELECT COUNT(*) FROM in_hand_updates WHERE status = 'pending') updates,
                       (SELECT COUNT(*) FROM stock_requests WHERE status = 'pending') requests`),
    pool.query(`SELECT v.id, p.team, p.kit, v.size, v.stock FROM variants v JOIN products p ON p.id = v.product_id
                 WHERE p.active AND v.stock <= $1 ORDER BY v.stock, p.team LIMIT 12`, [s.lowStockAt]),
    pool.query(`SELECT (SELECT COALESCE(SUM(amount),0) FROM commission_earnings WHERE paid_at IS NULL) commission,
                       (SELECT COALESCE(SUM(amount),0) FROM cash_ledger) cash`),
    pool.query(`SELECT COALESCE(SUM(quantity),0) n FROM in_hand`),
    pool.query(`SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE spent_at >= ${from}`),
  ]);

  const t = totals.rows[0];
  const commissionTotal = commission.rows[0].total;
  const team = (await associateStats(pool, s)).filter((a) => a.active);

  res.json({
    range,
    revenue: t.revenue,
    grossProfit: t.profit,
    commission: commissionTotal,
    expenses: expenses.rows[0].total,
    // Real profit = profit on jerseys − commission & bonuses − expenses
    netProfit: Math.round((t.profit - commissionTotal - expenses.rows[0].total) * 100) / 100,
    jerseys: t.jerseys,
    orders: t.orders,
    byChannel: channels.rows,
    daily: daily.rows,
    // Everything waiting in Pending Approvals
    pendingApprovals: pending.rows[0].sales,
    pendingJerseyUpdates: pending.rows[0].updates,
    pendingStockRequests: pending.rows[0].requests,
    lowStock: lowStock.rows,
    commissionOwed: owed.rows[0].commission,
    cashWithTeam: owed.rows[0].cash,
    jerseysWithTeam: inHand.rows[0].n,
    team: team.map((a) => ({
      id: a.id, name: a.name, level: a.level, periodJerseys: a.periodJerseys, madeForYou: a.madeForYou,
      warningDeadline: a.warningDeadline, pendingRemoval: a.pendingRemoval, onShiftSince: a.onShiftSince,
    })),
  });
});

// Associate's own dashboard: only their numbers, never business revenue or costs.
dashboardRoutes.get('/dashboard/me', async (req, res) => {
  const u = me(req);
  const s = await getSettings(pool);
  if (u.role === 'owner') return res.json({ role: 'owner' });
  const [stats] = await associateStats(pool, s, u.id);
  const events = await pool.query(
    `SELECT kind, from_level AS "fromLevel", to_level AS "toLevel", note, created_at AS "createdAt"
       FROM level_events WHERE associate_id = $1 ORDER BY created_at DESC LIMIT 10`,
    [u.id],
  );
  // Associates never get profit, cost or revenue numbers, not even "made for you" (that's CEO only).
  const { profitGenerated, revenueGenerated, madeForYou, ...visible } = stats;
  res.json({
    ...visible,
    rules: { setSize: s.setSize, commissionPerSet: s.commissionPerSet, levelTargets: s.levelTargets, periodMonths: s.periodMonths, milestones: s.milestones },
    recentEvents: events.rows,
  });
});
