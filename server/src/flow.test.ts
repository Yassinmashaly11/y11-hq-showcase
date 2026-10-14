import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from './app.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { runLevelChecks } from './services/levels.js';
import { DEFAULT_SETTINGS } from './domain/settings.js';
import { addMonths } from './domain/levels.js';

// End-to-end: real HTTP requests against a real (test) database.
const app = createApp();
const ceo = request.agent(app);
const yusuf = request.agent(app);
let yusufId = 0;
let variantId = 0;

beforeAll(async () => {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await migrate();
  await pool.query(`INSERT INTO settings (key, value) VALUES ('business', $1)`, [JSON.stringify(DEFAULT_SETTINGS)]);
  await pool.query(`INSERT INTO product_types (code, name, price, cost) VALUES ('fan_short', 'Short sleeve (fan)', 45, 18)`);
  await pool.query(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('yassin', $1, 'Yassin', 'owner')`, [await bcrypt.hash('ceo-pass-1', 4)]);
  await ceo.post('/api/auth/login').send({ username: 'yassin', password: 'ceo-pass-1' }).expect(200);
});
afterAll(() => pool.end());

describe('a full day at Y11', () => {
  it('rejects a wrong password', async () => {
    await request(app).post('/api/auth/login').send({ username: 'yassin', password: 'nope' }).expect(401);
  });

  it('CEO adds a jersey and an associate', async () => {
    const p = await ceo.post('/api/products').send({ team: 'Brazil', kit: 'Home', typeId: 1, sizes: [{ size: 'M', stock: 10 }] }).expect(201);
    variantId = (await pool.query(`SELECT id FROM variants WHERE product_id = $1`, [p.body.id])).rows[0].id;
    const a = await ceo.post('/api/team').send({ fullName: 'Yusuf Ahmed', username: 'yusuf', password: 'yusuf-pass' }).expect(201);
    yusufId = a.body.id;
    await yusuf.post('/api/auth/login').send({ username: 'yusuf', password: 'yusuf-pass' }).expect(200);
  });

  it('associates cannot see CEO pages or costs', async () => {
    await yusuf.get('/api/team').expect(403);
    await yusuf.get('/api/dashboard/owner').expect(403);
    const cat = await yusuf.get('/api/catalog').expect(200);
    expect(cat.body.types[0].cost).toBeUndefined();
  });

  it('CEO gives Yusuf 4 jerseys to carry', async () => {
    await ceo.post('/api/in-hand').send({ associateId: yusufId, variantId, quantity: 4 }).expect(201);
    const v = await pool.query(`SELECT stock FROM variants WHERE id = $1`, [variantId]);
    expect(v.rows[0].stock).toBe(6);
  });

  it('Yusuf sells 3 in-hand jerseys for cash; nothing counts until approved', async () => {
    const r = await yusuf.post('/api/sales').send({
      source: 'in_hand', paymentMethod: 'cash', customerName: 'Karim', items: [{ variantId, quantity: 3 }],
    }).expect(201);
    let me = (await yusuf.get('/api/dashboard/me')).body;
    expect(me).toMatchObject({ pendingSales: 1, commissionEarned: 0, jerseysInHand: 4 });

    await ceo.post(`/api/sales/${r.body.id}/approve`).expect(200);
    me = (await yusuf.get('/api/dashboard/me')).body;
    // 3 jerseys = one $24 payout; in-hand drops to 1; he owes $135 cash (in-hand sales have no shipping)
    expect(me).toMatchObject({ pendingSales: 0, commissionEarned: 24, jerseysInHand: 1, cashOwed: 135, periodJerseys: 3 });
    await ceo.post(`/api/sales/${r.body.id}/approve`).expect(409); // can't approve twice
  });

  it('a rejected e-Transfer sale changes nothing', async () => {
    const r = await yusuf.post('/api/sales').send({
      source: 'stock', paymentMethod: 'etransfer', customerName: 'Leo', customerEmail: 'leo@example.com', items: [{ variantId, quantity: 1 }],
    }).expect(201);
    await ceo.post(`/api/sales/${r.body.id}/reject`).send({ reason: 'No e-Transfer received' }).expect(200);
    const v = await pool.query(`SELECT stock FROM variants WHERE id = $1`, [variantId]);
    expect(v.rows[0].stock).toBe(6);
  });

  it('the same in-hand jersey cannot be logged twice while one sale is pending', async () => {
    const first = await yusuf.post('/api/sales').send({ source: 'in_hand', paymentMethod: 'cash', customerName: 'A', items: [{ variantId, quantity: 1 }] }).expect(201);
    await yusuf.post('/api/sales').send({ source: 'in_hand', paymentMethod: 'cash', customerName: 'B', items: [{ variantId, quantity: 1 }] }).expect(400);
    await ceo.post(`/api/sales/${first.body.id}/reject`).send({ reason: 'test' }).expect(200);
  });

  it('cannot sell more than is in stock', async () => {
    await yusuf.post('/api/sales').send({ source: 'in_hand', paymentMethod: 'cash', customerName: 'X', items: [{ variantId, quantity: 2 }] }).expect(400);
  });

  it('CEO dashboard shows the revenue and profit after commission', async () => {
    const d = (await ceo.get('/api/dashboard/owner?range=all')).body;
    expect(d).toMatchObject({ revenue: 135, grossProfit: 81, commission: 24, netProfit: 57, jerseys: 3, cashWithTeam: 135 });
  });

  it('cash handed over clears what he owes', async () => {
    await ceo.post(`/api/team/${yusufId}/cash-received`).send({ amount: 135 }).expect(200);
    expect((await yusuf.get('/api/dashboard/me')).body.cashOwed).toBe(0);
  });

  it('shift timer: one shift at a time', async () => {
    await yusuf.post('/api/shifts/start').expect(201);
    await yusuf.post('/api/shifts/start').expect(409);
    await yusuf.post('/api/shifts/end').expect(200);
    expect((await yusuf.get('/api/shifts/me')).body.shifts).toHaveLength(1);
  });

  it('level checks: skip first, then warn, then flag, then the CEO removes', async () => {
    const t0 = new Date();
    await pool.query(`UPDATE users SET period_start = $2 WHERE id = $1`, [yusufId, t0]);
    const check1 = addMonths(t0, 2);
    await runLevelChecks(check1);       // first check skipped
    await runLevelChecks(addMonths(check1, 2)); // second check: Level 1 → warning
    let me = (await yusuf.get('/api/dashboard/me')).body;
    expect(me.warningDeadline).not.toBeNull();
    await runLevelChecks(addMonths(check1, 3)); // warning month over
    me = (await yusuf.get('/api/dashboard/me')).body;
    expect(me.pendingRemoval).toBe(true);
    await ceo.post(`/api/team/${yusufId}/confirm-removal`).expect(200);
    await yusuf.get('/api/dashboard/me').expect(401); // locked out immediately
  });
});
