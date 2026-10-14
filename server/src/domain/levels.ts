import { BusinessSettings } from './settings.js';

// Pure commission + level rules. The database code loads an associate's state,
// runs one of these functions, and saves the result.

export interface AssociateState {
  level: 1 | 2 | 3;
  periodStart: Date;
  periodJerseys: number;    // resets at every 2-month check
  setProgress: number;      // jerseys toward the next set of 3 (carries over)
  skipNextCheck: boolean;   // true for new associates
  warningDeadline: Date | null;
  pendingRemoval: boolean;
  milestonesAwarded: number; // how many milestone bonuses were paid this period
}

export type LevelEventKind =
  | 'level_up'
  | 'warning_cleared'
  | 'period_drop'
  | 'first_check_skipped'
  | 'warning'
  | 'removal_flag'
  | 'milestone';

export interface LevelEvent {
  kind: LevelEventKind;
  fromLevel: number;
  toLevel: number;
  note?: string;
}

export interface Earning {
  amount: number;
  level: number;
  kind: 'commission' | 'milestone';
  note?: string;
}

export function addMonths(d: Date, months: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + months);
  return r;
}

export function nextCheckAt(st: AssociateState, s: BusinessSettings): Date {
  return addMonths(st.periodStart, s.periodMonths);
}

/** The level an associate should be at for a given number of jerseys this period. */
export function levelFor(jerseys: number, s: BusinessSettings): 1 | 2 | 3 {
  if (jerseys >= s.levelTargets.level3) return 3;
  if (jerseys >= s.levelTargets.level2) return 2;
  return 1;
}

/**
 * Apply an approved sale, one jersey at a time.
 * - Every jersey counts toward the period total; reaching 15 / 30 levels up immediately.
 * - A warned Level 1 who reaches 15 clears the warning and starts a fresh 2-month period.
 * - Every 3rd jersey pays a commission at the level held at that moment.
 */
export function applySale(prev: AssociateState, jerseys: number, now: Date, s: BusinessSettings) {
  const st: AssociateState = { ...prev };
  const earnings: Earning[] = [];
  const events: LevelEvent[] = [];

  for (let i = 0; i < jerseys; i++) {
    st.periodJerseys += 1;

    const target = levelFor(st.periodJerseys, s);
    if (target > st.level) {
      const from = st.level;
      st.level = target;
      if (st.warningDeadline) {
        // Made it out of the warning month: a new 2-month period starts now.
        st.warningDeadline = null;
        st.periodStart = now;
        st.periodJerseys = 0;
        st.milestonesAwarded = 0;
        events.push({ kind: 'warning_cleared', fromLevel: from, toLevel: target });
      } else {
        events.push({ kind: 'level_up', fromLevel: from, toLevel: target });
      }
    }

    st.setProgress += 1;
    if (st.setProgress >= s.setSize) {
      st.setProgress = 0;
      earnings.push({ amount: s.commissionPerSet[st.level - 1], level: st.level, kind: 'commission' });
    }

    // Milestone bonuses (45 / 60 / 80 jerseys in one period): each pays once per period.
    const next = s.milestones[st.milestonesAwarded];
    if (next && st.periodJerseys >= next.jerseys) {
      st.milestonesAwarded += 1;
      earnings.push({ amount: next.bonus, level: st.level, kind: 'milestone', note: `${next.jerseys} jerseys this period` });
      events.push({ kind: 'milestone', fromLevel: st.level, toLevel: st.level, note: `Hit ${next.jerseys} jerseys: +$${next.bonus} bonus` });
    }
  }

  return { state: st, earnings, events };
}

/**
 * The scheduled check. Safe to run as often as you like (hourly): it only acts when a
 * period or warning deadline has actually ended.
 */
export function runCheck(prev: AssociateState, now: Date, s: BusinessSettings) {
  const st: AssociateState = { ...prev };
  const events: LevelEvent[] = [];
  if (st.pendingRemoval) return { state: st, events };

  // 1. A warned associate whose month ran out is flagged for the CEO to confirm.
  if (st.warningDeadline && now >= st.warningDeadline) {
    st.pendingRemoval = true;
    events.push({ kind: 'removal_flag', fromLevel: st.level, toLevel: st.level, note: 'Missed the warning deadline' });
    return { state: st, events };
  }

  // 2. Not time yet.
  if (now < nextCheckAt(st, s)) return { state: st, events };

  // 3. The 2-month check. The count resets no matter what happens below.
  const from = st.level;
  st.periodStart = now;
  st.periodJerseys = 0;
  st.milestonesAwarded = 0;

  if (st.skipNextCheck) {
    st.skipNextCheck = false;
    events.push({ kind: 'first_check_skipped', fromLevel: from, toLevel: from });
  } else if (st.level > 1) {
    st.level = (st.level - 1) as 1 | 2;
    events.push({ kind: 'period_drop', fromLevel: from, toLevel: st.level });
  } else {
    st.warningDeadline = addMonths(now, s.warningMonths);
    events.push({
      kind: 'warning',
      fromLevel: 1,
      toLevel: 1,
      note: `Must reach Level 2 (${s.levelTargets.level2} jerseys) by ${st.warningDeadline.toISOString().slice(0, 10)}`,
    });
  }
  return { state: st, events };
}
