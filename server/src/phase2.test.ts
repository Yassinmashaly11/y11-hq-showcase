import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from './app.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { DEFAULT_SETTINGS } from './domain/settings.js';
import { autoEndShifts } from './services/jobs.js';

// Phase 2 end-to-end: payouts, bonuses, codes, announcements, notifications,
// expenses, customers, reports and shift auto-end.
const app = createApp();
const ceo = request.agent(app);
const yusuf = request.agent(app);
const omar = request.agent(app);
let yusufId = 0, omarId = 0, variantId = 0;

async function sell(agent: ReturnType<typeof request.agent>, quantity: number, customer = 'Karim', email = 'k@example.com') {
  const r = await agent.post('/api/sales').send({
    source: 'stock', paymentMethod: 'etransfer', customerName: customer, customerEmail: email, items: [{ variantId, quantity }],
  }).expect(201);
  await ceo.post(`/api/sales/${r.body.id}/approve`).expect(200);
}

beforeAll(async () => {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await migrate();
  await pool.query(`INSERT INTO settings (key, value) VALUES ('business', $1)`, [JSON.stringify(DEFAULT_SETTINGS)]);
  await pool.query(`INSERT INTO product_types (code, name, price, cost) VALUES ('fan_short', 'Short sleeve (fan)', 45, 18)`);
  await pool.query(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('yassin', $1, 'Yassin', 'owner')`, [await bcrypt.hash('ceo-pass-1', 4)]);
  await ceo.post('/api/auth/login').send({ username: 'yassin', password: 'ceo-pass-1' }).expect(200);
  const p = await ceo.post('/api/products').send({ team: 'Brazil', kit: 'Home', typeId: 1, sizes: [{ size: 'M', stock: 500 }] });
  variantId = (await pool.query(`SELECT id FROM variants WHERE product_id = $1`, [p.body.id])).rows[0].id;
  yusufId = (await ceo.post('/api/team').send({ fullName: 'Yusuf Ahmed', username: 'yusuf', password: 'yusuf-pass' })).body.id;
  omarId = (await ceo.post('/api/team').send({ fullName: 'Omar Khalil', username: 'omar', password: 'omar-pass1' })).body.id;
  await yusuf.post('/api/auth/login').send({ username: 'yusuf', password: 'yusuf-pass' }).expect(200);
  await omar.post('/api/auth/login').send({ username: 'omar', password: 'omar-pass1' }).expect(200);
});
afterAll(() => pool.end());

describe('notifications', () => {
  it('CEO is notified of a pending sale; associate when it is approved', async () => {
    const r = await yusuf.post('/api/sales').send({ source: 'stock', paymentMethod: 'cash', customerName: 'Sara', items: [{ variantId, quantity: 1 }] }).expect(201);
    const bell = (await ceo.get('/api/notifications')).body;
    expect(bell.unread).toBeGreaterThan(0);
    expect(bell.items[0].kind).toBe('sale_pending');
    await ceo.post(`/api/sales/${r.body.id}/approve`).expect(200);
    expect((await yusuf.get('/api/notifications')).body.items[0].kind).toBe('sale_approved');
    await yusuf.post('/api/notifications/read-all').expect(200);
    expect((await yusuf.get('/api/notifications')).body.unread).toBe(0);
  });
});

describe('milestone bonuses and payouts', () => {
  it('45 jerseys in a period pays a $25 bonus on top of commission', async () => {
    await sell(yusuf, 44, 'Daniel', 'd@example.com'); // 1 from before + 44 = 45
    const unpaid = (await yusuf.get('/api/earnings/unpaid')).body;
    const bonus = unpaid.filter((e: any) => e.kind === 'milestone');
    expect(bonus).toHaveLength(1);
    expect(bonus[0].amount).toBe(25);
    // 45 jerseys = 15 sets: 4 × $24, then Level 2 from jersey 15 (5th set $30 + 4 × $30), Level 3 from 30 (10th set $36 + 5 × $36)
    const commission = unpaid.filter((e: any) => e.kind === 'commission').reduce((n: number, e: any) => n + e.amount, 0);
    expect(commission).toBe(4 * 24 + 5 * 30 + 6 * 36);
  });

  it('CEO pays everything owed; the statement lists every line', async () => {
    const summary = (await ceo.get('/api/payouts/summary')).body;
    const owed = summary.find((s: any) => s.id === yusufId).owed;
    const p = await ceo.post('/api/payouts').send({ associateId: yusufId, method: 'etransfer' }).expect(201);
    expect(p.body.amount).toBe(owed);
    const statement = (await yusuf.get(`/api/payouts/${p.body.id}`)).body;
    expect(statement.lines.reduce((n: number, l: any) => n + l.amount, 0)).toBe(owed);
    expect((await yusuf.get('/api/earnings/unpaid')).body).toHaveLength(0);
    await ceo.post('/api/payouts').send({ associateId: yusufId }).expect(400); // nothing left
    await omar.get(`/api/payouts/${p.body.id}`).expect(404); // can't see someone else's statement
  });
});

describe('promo codes and announcements', () => {
  it('codes are unique and associates only see their own', async () => {
    await ceo.post('/api/promo-codes').send({ associateId: yusufId, code: 'yusuf10' }).expect(201);
    await ceo.post('/api/promo-codes').send({ associateId: omarId, code: 'YUSUF10' }).expect(409);
    await ceo.post('/api/promo-codes').send({ associateId: omarId, code: 'OMAR7' }).expect(201);
    const mine = (await omar.get('/api/promo-codes')).body;
    expect(mine.codes.map((c: any) => c.code)).toEqual(['OMAR7']);
    expect(mine.links[0].url).toMatch(/\?ref=omar$/);
    await yusuf.post('/api/promo-codes').send({ associateId: yusufId, code: 'HACK' }).expect(403);
  });

  it('announcements reach every associate', async () => {
    await ceo.post('/api/announcements').send({ title: 'New kits', body: 'Arsenal in stock' }).expect(201);
    expect((await omar.get('/api/announcements')).body[0].title).toBe('New kits');
    expect((await omar.get('/api/notifications')).body.items[0].kind).toBe('announcement');
    await omar.post('/api/announcements').send({ title: 'x', body: 'y' }).expect(403);
  });
});

describe('leaderboard, customers, expenses, reports', () => {
  it('leaderboard ranks by jerseys and marks you', async () => {
    const lb = (await omar.get('/api/leaderboard?range=all')).body;
    expect(lb[0]).toMatchObject({ name: 'Yusuf Ahmed', rank: 1 });
    expect(lb.find((r: any) => r.isMe).name).toBe('Omar Khalil');
    // The CEO is on the leaderboard too, with their own sales
    expect(lb.some((r: any) => r.role === 'owner')).toBe(true);
    await omar.get('/api/challenges').expect(404); // challenges were removed
  });

  it('customers are grouped by email, repeat buyers counted', async () => {
    await sell(omar, 3, 'Leo', 'leo@example.com');
    await sell(yusuf, 1, 'Leo', 'leo@example.com');
    const c = (await ceo.get('/api/customers')).body;
    const leo = c.customers.find((x: any) => x.email === 'leo@example.com');
    expect(leo.orders).toBe(2);
    expect(c.repeat).toBeGreaterThanOrEqual(1);
    await yusuf.get('/api/customers').expect(403);
  });

  it('expenses come off real profit on the dashboard', async () => {
    const before = (await ceo.get('/api/dashboard/owner?range=all')).body;
    await ceo.post('/api/expenses').send({ category: 'Ads', description: 'Instagram', amount: 50 }).expect(201);
    const after = (await ceo.get('/api/dashboard/owner?range=all')).body;
    expect(after.expenses).toBe(50);
    expect(after.netProfit).toBe(Math.round((before.netProfit - 50) * 100) / 100);
  });

  it('exports sales as a CSV spreadsheet', async () => {
    const r = await ceo.get('/api/reports/sales.csv').expect(200);
    expect(r.headers['content-type']).toMatch(/text\/csv/);
    expect(r.text.split('\n')[0]).toContain('order_id,date,sold_by');
    expect(r.text.split('\n').length).toBeGreaterThan(3);
    await yusuf.get('/api/reports/sales.csv').expect(403);
  });

  it('activity log records payouts', async () => {
    const log = (await ceo.get('/api/activity')).body;
    expect(log.entries.some((l: any) => l.action === 'payout_made')).toBe(true);
  });
});

describe('shift auto-end', () => {
  it('a shift left running past 10 hours ends at exactly 10 hours', async () => {
    await omar.post('/api/shifts/start').expect(201);
    await pool.query(`UPDATE shifts SET started_at = now() - interval '11 hours' WHERE user_id = $1 AND ended_at IS NULL`, [omarId]);
    expect(await autoEndShifts()).toBe(1);
    const s = (await omar.get('/api/shifts/me')).body;
    expect(s.open).toBeNull();
    expect(s.shifts[0].autoEnded).toBe(true);
    expect(s.totals.allTime).toBe(10);
    expect((await omar.get('/api/notifications')).body.items[0].kind).toBe('shift_auto_ended');
  });
});
