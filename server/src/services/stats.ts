import { Db } from '../db/pool.js';
import { BusinessSettings } from '../domain/settings.js';
import { nextCheckAt } from '../domain/levels.js';

/** Everything Team (CEO) and My Dashboard (associate) show about one or more associates. */
export async function associateStats(db: Db, s: BusinessSettings, onlyId?: number) {
  const r = await db.query(
    `SELECT u.id, u.full_name AS "name", u.username, u.active, u.can_see_stock AS "canSeeStock", u.created_at AS "joinedAt",
            u.level, u.period_start AS "periodStart", u.period_jerseys AS "periodJerseys", u.set_progress AS "setProgress",
            u.skip_next_check AS "skipNextCheck", u.milestones_awarded AS "milestonesAwarded", u.referral_code AS "referralCode", u.warning_deadline AS "warningDeadline", u.pending_removal AS "pendingRemoval",
            COALESCE(sa.jerseys, 0) AS "jerseysAllTime",
            COALESCE(sa.profit, 0) AS "profitGenerated",
            COALESCE(sa.revenue, 0) AS "revenueGenerated",
            COALESCE(ce.earned, 0) AS "commissionEarned",
            COALESCE(ce.unpaid, 0) AS "commissionUnpaid",
            COALESCE(cl.owed, 0) AS "cashOwed",
            COALESCE(ih.jerseys, 0) AS "jerseysInHand",
            COALESCE(ih.overdue, 0) AS "jerseysOverdue",
            COALESCE(ps.n, 0) AS "pendingSales",
            COALESCE(sh.hours_month, 0) AS "hoursThisMonth",
            COALESCE(sh.hours_all, 0) AS "hoursAllTime",
            sh.open_since AS "onShiftSince"
       FROM users u
       LEFT JOIN (SELECT associate_id, SUM(jersey_count) jerseys, SUM(profit) profit, SUM(revenue) revenue
                    FROM sales WHERE status = 'approved' GROUP BY associate_id) sa ON sa.associate_id = u.id
       LEFT JOIN (SELECT associate_id, SUM(amount) earned, SUM(amount) FILTER (WHERE paid_at IS NULL) unpaid
                    FROM commission_earnings GROUP BY associate_id) ce ON ce.associate_id = u.id
       LEFT JOIN (SELECT associate_id, SUM(amount) owed FROM cash_ledger GROUP BY associate_id) cl ON cl.associate_id = u.id
       LEFT JOIN (SELECT h.associate_id, SUM(h.quantity) jerseys, SUM(h.quantity) FILTER (WHERE h.due_at < now() AND r.id IS NULL) overdue
                    FROM in_hand h LEFT JOIN in_hand_updates r ON r.in_hand_id = h.id AND r.status = 'pending'
                   GROUP BY h.associate_id) ih ON ih.associate_id = u.id
       LEFT JOIN (SELECT associate_id, COUNT(*) n FROM sales WHERE status = 'pending' GROUP BY associate_id) ps ON ps.associate_id = u.id
       LEFT JOIN (SELECT user_id,
                         SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)) / 3600)
                           FILTER (WHERE started_at >= date_trunc('month', now())) hours_month,
                         SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, now()) - started_at)) / 3600) hours_all,
                         MAX(started_at) FILTER (WHERE ended_at IS NULL) open_since
                    FROM shifts GROUP BY user_id) sh ON sh.user_id = u.id
      WHERE u.role = 'associate' ${onlyId ? 'AND u.id = $1' : ''}
      ORDER BY u.active DESC, u.level DESC, u.period_jerseys DESC`,
    onlyId ? [onlyId] : [],
  );

  return r.rows.map((a) => {
    const level = a.level as 1 | 2 | 3;
    const nextTarget = level === 1 ? s.levelTargets.level2 : level === 2 ? s.levelTargets.level3 : null;
    return {
      ...a,
      hoursThisMonth: Math.round(a.hoursThisMonth * 10) / 10,
      hoursAllTime: Math.round(a.hoursAllTime * 10) / 10,
      // Your share of the profit they brought in, after their commission
      madeForYou: Math.round((a.profitGenerated - a.commissionEarned) * 100) / 100,
      nextLevel: nextTarget ? level + 1 : null,
      periodTarget: nextTarget,
      setSize: s.setSize,
      jerseysToNextLevel: nextTarget ? Math.max(0, nextTarget - a.periodJerseys) : 0,
      nextCheckAt: nextCheckAt({ periodStart: a.periodStart } as any, s),
      jerseysToNextPayout: s.setSize - a.setProgress,
      nextPayoutAmount: s.commissionPerSet[level - 1],
      perJersey: Math.round((s.commissionPerSet[level - 1] / s.setSize) * 100) / 100,
      nextMilestone: s.milestones[a.milestonesAwarded] ?? null,
      jerseysToMilestone: s.milestones[a.milestonesAwarded] ? Math.max(0, s.milestones[a.milestonesAwarded].jerseys - a.periodJerseys) : 0,
    };
  });
}
