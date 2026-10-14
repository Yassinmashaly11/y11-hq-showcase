import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS as S } from './settings.js';
import { priceSale } from './pricing.js';
import { AssociateState, applySale, runCheck, addMonths } from './levels.js';

const fanShort = { typePrice: 45, typeCost: 18 }; // sample cost, not a real supplier price
const line = (o: Partial<Parameters<typeof priceSale>[0][number]> = {}) => ({
  size: 'M', quantity: 1, nameNumber: false, patch: false, ...fanShort, ...o,
});

describe('pricing', () => {
  it('prices a plain fan jersey at $45 with $27 profit', () => {
    const t = priceSale([line()], S, { chargeShipping: true });
    expect(t).toMatchObject({ revenue: 45, cost: 18, profit: 27, shipping: 8, squadDeal: false });
  });

  it('charges $10 for name & number and costs $3', () => {
    const t = priceSale([line({ nameNumber: true })], S, { chargeShipping: false });
    expect(t).toMatchObject({ revenue: 55, cost: 21, profit: 34 });
  });

  it('Squad Deal: 4+ jerseys make name & number free, but you still pay the supplier', () => {
    const t = priceSale([line({ quantity: 4, nameNumber: true })], S, { chargeShipping: true });
    expect(t).toMatchObject({ squadDeal: true, revenue: 180, cost: 84, profit: 96, shipping: 0 });
  });

  it('shipping: $8 for 1, $6 for 2, free for 3+', () => {
    expect(priceSale([line()], S, { chargeShipping: true }).shipping).toBe(8);
    expect(priceSale([line({ quantity: 2 })], S, { chargeShipping: true }).shipping).toBe(6);
    expect(priceSale([line({ quantity: 3 })], S, { chargeShipping: true }).shipping).toBe(0);
  });

  it('2XL adds to price and cost', () => {
    const t = priceSale([line({ size: '2XL' })], S, { chargeShipping: false });
    expect(t).toMatchObject({ revenue: 50, cost: 20 });
  });

  it('WhatsApp orders: $5 off every jersey comes off revenue and profit, not cost or shipping', () => {
    const t = priceSale([line({ quantity: 2 })], S, { chargeShipping: true, whatsapp: true });
    expect(t).toMatchObject({ whatsappDiscount: 10, revenue: 80, cost: 36, profit: 44, shipping: 6 });
    expect(priceSale([line({ quantity: 2 })], S, { chargeShipping: true }).whatsappDiscount).toBe(0);
  });

  it('WhatsApp discount stacks with the Squad Deal and never makes revenue negative', () => {
    const squad = priceSale([line({ quantity: 4, nameNumber: true })], S, { chargeShipping: true, whatsapp: true });
    expect(squad).toMatchObject({ squadDeal: true, whatsappDiscount: 20, revenue: 160, cost: 84, profit: 76 });
    const huge = priceSale([line()], { ...S, whatsappDiscount: 100 }, { chargeShipping: false, whatsapp: true });
    expect(huge).toMatchObject({ whatsappDiscount: 45, revenue: 0 });
  });
});

const now = new Date('2026-10-08T12:00:00Z');
const fresh = (o: Partial<AssociateState> = {}): AssociateState => ({
  level: 1, periodStart: now, periodJerseys: 0, setProgress: 0,
  skipNextCheck: false, warningDeadline: null, pendingRemoval: false, milestonesAwarded: 0, ...o,
});

describe('commission', () => {
  it('pays nothing until the 3rd jersey, then $24 at Level 1', () => {
    expect(applySale(fresh(), 2, now, S).earnings).toEqual([]);
    expect(applySale(fresh(), 3, now, S).earnings).toEqual([{ amount: 24, level: 1, kind: 'commission' }]);
  });

  it('9 jerseys at Level 1 = $72', () => {
    const r = applySale(fresh(), 9, now, S);
    expect(r.earnings.reduce((n, e) => n + e.amount, 0)).toBe(72);
  });

  it('leftover jerseys carry over to the next sale', () => {
    const a = applySale(fresh(), 2, now, S);
    const b = applySale(a.state, 1, now, S);
    expect(b.earnings).toEqual([{ amount: 24, level: 1, kind: 'commission' }]);
  });

  it('levels up on the 15th jersey and that set pays $30', () => {
    const r = applySale(fresh({ periodJerseys: 14, setProgress: 2 }), 1, now, S);
    expect(r.state.level).toBe(2);
    expect(r.events[0].kind).toBe('level_up');
    expect(r.earnings).toEqual([{ amount: 30, level: 2, kind: 'commission' }]);
  });

  it('reaches Level 3 at 30 jerseys and pays $36 per set', () => {
    const r = applySale(fresh({ level: 2, periodJerseys: 27 }), 3, now, S);
    expect(r.state.level).toBe(3);
    expect(r.earnings).toEqual([{ amount: 36, level: 3, kind: 'commission' }]);
  });
});

describe('milestone bonuses', () => {
  const bonuses = (r: ReturnType<typeof applySale>) => r.earnings.filter((e) => e.kind === 'milestone').map((e) => e.amount);

  it('pays $25 on the 45th jersey of the period, once', () => {
    const r = applySale(fresh({ level: 3, periodJerseys: 44 }), 1, now, S);
    expect(bonuses(r)).toEqual([25]);
    expect(bonuses(applySale(r.state, 1, now, S))).toEqual([]);
  });

  it('stacks: 80 jerseys in one period = $25 + $50 + $100', () => {
    const r = applySale(fresh(), 80, now, S);
    expect(bonuses(r)).toEqual([25, 50, 100]);
  });

  it('resets at the 2-month check', () => {
    const r = applySale(fresh({ level: 3, periodJerseys: 44 }), 1, now, S);
    const after = runCheck(r.state, addMonths(now, 2), S).state;
    expect(after.milestonesAwarded).toBe(0);
    expect(bonuses(applySale(after, 45, addMonths(now, 2), S))).toEqual([25]);
  });
});

describe('2-month checks', () => {
  const later = addMonths(now, 2);

  it('does nothing before the period ends', () => {
    const r = runCheck(fresh({ level: 3 }), addMonths(now, 1), S);
    expect(r.state.level).toBe(3);
    expect(r.events).toEqual([]);
  });

  it('drops everyone one level and resets the count', () => {
    const r = runCheck(fresh({ level: 3, periodJerseys: 40 }), later, S);
    expect(r.state).toMatchObject({ level: 2, periodJerseys: 0 });
    expect(r.state.periodStart).toEqual(later);
  });

  it('new associates skip their first check', () => {
    const r = runCheck(fresh({ skipNextCheck: true }), later, S);
    expect(r.state).toMatchObject({ level: 1, skipNextCheck: false, warningDeadline: null });
    expect(r.events[0].kind).toBe('first_check_skipped');
  });

  it('warns Level 1 and gives 1 month', () => {
    const r = runCheck(fresh(), later, S);
    expect(r.events[0].kind).toBe('warning');
    expect(r.state.warningDeadline).toEqual(addMonths(later, 1));
  });

  it('clears the warning when they sell 15 in the month, and starts a new period', () => {
    const warned = runCheck(fresh(), later, S).state;
    const saleDay = addMonths(later, 0);
    saleDay.setDate(saleDay.getDate() + 20);
    const r = applySale(warned, 15, saleDay, S);
    expect(r.state).toMatchObject({ level: 2, warningDeadline: null, periodJerseys: 0 });
    expect(r.state.periodStart).toEqual(saleDay);
    expect(r.events.map((e) => e.kind)).toContain('warning_cleared');
  });

  it('flags for removal if the warning month runs out', () => {
    const warned = runCheck(fresh(), later, S).state;
    const r = runCheck(applySale(warned, 10, later, S).state, addMonths(later, 1), S);
    expect(r.state.pendingRemoval).toBe(true);
    expect(r.events[0].kind).toBe('removal_flag');
  });
});
