import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from './app.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { DEFAULT_SETTINGS } from './domain/settings.js';
import { notifyOverdueInHand } from './services/jobs.js';
import { clientIp, createLoginLimiter } from './services/login-limit.js';
import { checkProductionEnv } from './env.js';

// Phase 3: associates never see profit, jersey updates, selling from in hand, stock requests, going online safely.
const app = createApp();
const ceo = request.agent(app);
const yusuf = request.agent(app);
const omar = request.agent(app);
let yusufId = 0, omarId = 0, variantId = 0;

const stock = async () => (await pool.query(`SELECT stock FROM variants WHERE id = $1`, [variantId])).rows[0].stock as number;
const myJerseys = async (agent: ReturnType<typeof request.agent>) => (await agent.get('/api/in-hand').expect(200)).body as any[];
const bell = async (agent: ReturnType<typeof request.agent>) => (await agent.get('/api/notifications')).body.items as any[];
const pendingUpdates = async () => (await ceo.get('/api/jersey-updates?status=pending').expect(200)).body as any[];

/** Every key in a JSON response, however deeply nested. */
const allKeys = (v: unknown): string[] =>
  Array.isArray(v) ? v.flatMap(allKeys)
    : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...allKeys(x)])
    : [];

beforeAll(async () => {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await migrate();
  await pool.query(`INSERT INTO settings (key, value) VALUES ('business', $1)`, [JSON.stringify(DEFAULT_SETTINGS)]);
  await pool.query(`INSERT INTO product_types (code, name, price, cost) VALUES ('fan_short', 'Short sleeve (fan)', 45, 18)`);
  await pool.query(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('yassin', $1, 'Yassin', 'owner')`, [await bcrypt.hash('ceo-pass-1', 4)]);
  await ceo.post('/api/auth/login').send({ username: 'yassin', password: 'ceo-pass-1' }).expect(200);
  const p = await ceo.post('/api/products').send({ team: 'Brazil', kit: 'Home', typeId: 1, sizes: [{ size: 'M', stock: 20 }] });
  variantId = (await pool.query(`SELECT id FROM variants WHERE product_id = $1`, [p.body.id])).rows[0].id;
  yusufId = (await ceo.post('/api/team').send({ fullName: 'Yusuf Ahmed', username: 'yusuf', password: 'yusuf-pass' })).body.id;
  omarId = (await ceo.post('/api/team').send({ fullName: 'Omar Khalil', username: 'omar', password: 'omar-pass1' })).body.id;
  await yusuf.post('/api/auth/login').send({ username: 'yusuf', password: 'yusuf-pass' }).expect(200);
  await omar.post('/api/auth/login').send({ username: 'omar', password: 'omar-pass1' }).expect(200);
});
afterAll(() => pool.end());

describe('associates never see profit', () => {
  it('My Dashboard has no profit, cost, revenue or "made for you"; the CEO still sees "made for you"', async () => {
    const r = await yusuf.post('/api/sales').send({
      source: 'stock', paymentMethod: 'etransfer', customerName: 'Karim', customerEmail: 'k@example.com', items: [{ variantId, quantity: 3 }],
    }).expect(201);
    await ceo.post(`/api/sales/${r.body.id}/approve`).expect(200);

    const mine = (await yusuf.get('/api/dashboard/me').expect(200)).body;
    expect(mine.jerseysAllTime).toBe(3);
    expect(allKeys(mine).filter((k) => /profit|cost|revenue|madefor/i.test(k))).toEqual([]);

    // 3 × $45 revenue − 3 × $18 cost = $81 profit, minus Yusuf's $24 commission
    const team = (await ceo.get('/api/team').expect(200)).body;
    expect(team.find((a: any) => a.id === yusufId).madeForYou).toBe(57);
    const dash = (await ceo.get('/api/dashboard/owner?range=all').expect(200)).body;
    expect(dash.team.find((a: any) => a.id === yusufId).madeForYou).toBe(57);
  });
});

describe('jersey updates', () => {
  it('reporting 1 of 4 returned changes nothing yet: it shows as waiting and the CEO is notified', async () => {
    await ceo.post('/api/in-hand').send({ associateId: yusufId, variantId, quantity: 4 }).expect(201);
    expect(await stock()).toBe(13);
    const [batch] = await myJerseys(yusuf);
    await yusuf.post(`/api/in-hand/${batch.id}/updates`).send({ kind: 'returned', quantity: 1 }).expect(201);

    expect(await stock()).toBe(13);
    const rows = await myJerseys(yusuf);
    expect(rows).toHaveLength(2); // the 1 being returned is split off from the other 3
    expect(rows.find((h) => !h.pendingUpdate).quantity).toBe(3);
    const waiting = rows.find((h) => h.pendingUpdate);
    expect(waiting).toMatchObject({ quantity: 1, pendingUpdate: { kind: 'returned' } });
    expect((await yusuf.get('/api/dashboard/me')).body.jerseysInHand).toBe(4);

    expect((await bell(ceo))[0].kind).toBe('jersey_update');
    const list = await pendingUpdates();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ associateName: 'Yusuf Ahmed', kind: 'returned', quantity: 1, team: 'Brazil', size: 'M' });

    await yusuf.post(`/api/in-hand/${waiting.id}/updates`).send({ kind: 'lost' }).expect(409); // already waiting
  });

  it('a waiting jersey cannot be sold, and the CEO cannot also mark it returned from Inventory', async () => {
    await yusuf.post('/api/sales').send({ source: 'in_hand', paymentMethod: 'cash', customerName: 'A', items: [{ variantId, quantity: 4 }] }).expect(400);
    const waiting = (await myJerseys(yusuf)).find((h) => h.pendingUpdate);
    await ceo.post(`/api/in-hand/${waiting.id}/return`).send({}).expect(409);
  });

  it('confirming a return puts it back into main stock and tells Yusuf', async () => {
    const [u] = await pendingUpdates();
    await ceo.post(`/api/jersey-updates/${u.id}/confirm`).expect(200);
    expect(await stock()).toBe(14);
    const rows = await myJerseys(yusuf);
    expect(rows.map((h) => h.quantity)).toEqual([3]);
    expect((await yusuf.get('/api/dashboard/me')).body.jerseysInHand).toBe(3);
    expect((await bell(yusuf))[0].kind).toBe('jersey_update_confirmed');
    await ceo.post(`/api/jersey-updates/${u.id}/confirm`).expect(409); // can't confirm twice
  });

  it('confirming lost/damaged removes it, keeps it out of stock, and adds its cost as an expense', async () => {
    const before = (await ceo.get('/api/dashboard/owner?range=all')).body;
    const [batch] = await myJerseys(yusuf);
    await yusuf.post(`/api/in-hand/${batch.id}/updates`).send({ kind: 'damaged', quantity: 2, note: 'Torn sleeve' }).expect(201);
    const [u] = await pendingUpdates();
    expect(u.cost).toBe(36); // the CEO sees what it will cost before confirming
    await ceo.post(`/api/jersey-updates/${u.id}/confirm`).expect(200);

    expect(await stock()).toBe(14); // not back in stock
    expect((await myJerseys(yusuf)).map((h) => h.quantity)).toEqual([1]);
    const expenses = (await ceo.get('/api/expenses')).body.items;
    const e = expenses.find((x: any) => x.category === 'Lost/damaged jersey');
    expect(e.amount).toBe(36); // 2 × $18 supplier cost
    expect(e.description).toContain('Torn sleeve');
    const after = (await ceo.get('/api/dashboard/owner?range=all')).body;
    expect(after.netProfit).toBe(Math.round((before.netProfit - 36) * 100) / 100);
  });

  it('a jersey already in a pending sale cannot be reported', async () => {
    const sale = await yusuf.post('/api/sales').send({ source: 'in_hand', paymentMethod: 'cash', customerName: 'B', items: [{ variantId, quantity: 1 }] }).expect(201);
    const [h] = await myJerseys(yusuf);
    await yusuf.post(`/api/in-hand/${h.id}/updates`).send({ kind: 'returned' }).expect(400);
    await ceo.post(`/api/sales/${sale.body.id}/reject`).send({ reason: 'test' }).expect(200);
  });

  it('a waiting jersey is not overdue; declining makes it a normal (overdue) jersey again', async () => {
    const [h] = await myJerseys(yusuf);
    await pool.query(`UPDATE in_hand SET due_at = now() - interval '1 day' WHERE id = $1`, [h.id]);
    const expensesBefore = (await ceo.get('/api/expenses')).body.items.length;
    await yusuf.post(`/api/in-hand/${h.id}/updates`).send({ kind: 'lost' }).expect(201);
    expect((await bell(ceo))[0].message).toContain('as lost or stolen');

    expect((await yusuf.get('/api/dashboard/me')).body.jerseysOverdue).toBe(0);
    expect((await myJerseys(yusuf))[0].overdue).toBe(false);
    await notifyOverdueInHand();
    expect((await bell(yusuf)).some((n) => n.kind === 'in_hand_overdue')).toBe(false);

    const [u] = await pendingUpdates();
    await ceo.post(`/api/jersey-updates/${u.id}/decline`).expect(200);
    expect((await bell(yusuf))[0].kind).toBe('jersey_update_declined');
    expect(await myJerseys(yusuf)).toMatchObject([{ quantity: 1, pendingUpdate: null, overdue: true }]);
    expect((await yusuf.get('/api/dashboard/me')).body.jerseysOverdue).toBe(1);
    await notifyOverdueInHand();
    expect((await bell(yusuf)).some((n) => n.kind === 'in_hand_overdue')).toBe(true);
    expect(await stock()).toBe(14);
    expect((await ceo.get('/api/expenses')).body.items.length).toBe(expensesBefore); // declined: no expense
  });

  it('declining part of a batch puts it back with the rest', async () => {
    await ceo.post('/api/in-hand').send({ associateId: omarId, variantId, quantity: 3 }).expect(201);
    const [batch] = await myJerseys(omar);
    await omar.post(`/api/in-hand/${batch.id}/updates`).send({ kind: 'lost', quantity: 1 }).expect(201);
    expect(await myJerseys(omar)).toHaveLength(2);
    const u = (await pendingUpdates()).find((x) => x.associateId === omarId);
    await ceo.post(`/api/jersey-updates/${u.id}/decline`).expect(200);
    expect(await myJerseys(omar)).toMatchObject([{ quantity: 3, pendingUpdate: null }]);
  });

  it('associates can only report their own jerseys, and only the CEO decides', async () => {
    const [yusufs] = await myJerseys(yusuf);
    await omar.post(`/api/in-hand/${yusufs.id}/updates`).send({ kind: 'returned' }).expect(404);
    await ceo.post(`/api/in-hand/${yusufs.id}/updates`).send({ kind: 'returned' }).expect(404); // the CEO uses Inventory instead
    await yusuf.post(`/api/in-hand/${yusufs.id}/updates`).send({ kind: 'stolen' }).expect(400);
    await yusuf.get('/api/jersey-updates').expect(403);
    await yusuf.post('/api/jersey-updates/1/confirm').expect(403);
    await yusuf.post('/api/jersey-updates/1/decline').expect(403);
  });

  it('every request, confirmation and decline is in the Activity Log', async () => {
    const actions = (await ceo.get('/api/activity')).body.entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['jersey_update_requested', 'jersey_update_confirmed', 'jersey_update_declined']));
  });
});

describe('selling from in hand, and the Given · Sold · Left summary', () => {
  const adam = request.agent(app);
  let adamId = 0, argentina = 0, saleId = 0;
  const mine = async () => (await adam.get('/api/in-hand/mine').expect(200)).body;

  beforeAll(async () => {
    const p = await ceo.post('/api/products').send({ team: 'Argentina', kit: 'Home', typeId: 1, sizes: [{ size: 'M', stock: 20 }] });
    argentina = (await pool.query(`SELECT id FROM variants WHERE product_id = $1`, [p.body.id])).rows[0].id;
    adamId = (await ceo.post('/api/team').send({ fullName: 'Adam Rossi', username: 'adam', password: 'adam-pass1' })).body.id;
    await adam.post('/api/auth/login').send({ username: 'adam', password: 'adam-pass1' }).expect(200);
    await ceo.post('/api/in-hand').send({ associateId: adamId, variantId: argentina, quantity: 5 }).expect(201);
  });

  it('jerseys in a pending sale show as waiting, then as sold, and the summary adds up', async () => {
    expect(await mine()).toMatchObject({ given: 5, sold: 0, left: 5, recentlySold: [] });
    const s = await adam.post('/api/sales').send({ source: 'in_hand', paymentMethod: 'cash', customerName: 'Nour', items: [{ variantId: argentina, quantity: 2 }] }).expect(201);
    saleId = s.body.id;
    expect(await myJerseys(adam)).toMatchObject([{ quantity: 5, inPendingSale: 2 }]);

    await ceo.post(`/api/sales/${saleId}/approve`).expect(200);
    expect(await myJerseys(adam)).toMatchObject([{ quantity: 3, inPendingSale: 0 }]);
    const m = await mine();
    expect(m).toMatchObject({ given: 5, sold: 2, returned: 0, lostOrDamaged: 0, left: 3 });
    expect(m.recentlySold).toMatchObject([{ quantity: 2, team: 'Argentina', size: 'M' }]);
    expect(m.recentlySold[0].soldAt).toBeTruthy();
  });

  it('sold jerseys stay on the list for 30 days, but always count in the summary', async () => {
    await pool.query(`UPDATE sales SET decided_at = now() - interval '31 days' WHERE id = $1`, [saleId]);
    expect(await mine()).toMatchObject({ sold: 2, recentlySold: [] });
  });

  it('returns (including ones the CEO marks in Inventory) and lost jerseys keep the summary adding up', async () => {
    const [h] = await myJerseys(adam);
    await adam.post(`/api/in-hand/${h.id}/updates`).send({ kind: 'returned', quantity: 1 }).expect(201);
    await ceo.post(`/api/jersey-updates/${(await pendingUpdates())[0].id}/confirm`).expect(200);
    const [h2] = await myJerseys(adam);
    await ceo.post(`/api/in-hand/${h2.id}/return`).send({ quantity: 1 }).expect(200);
    await adam.post(`/api/in-hand/${h2.id}/updates`).send({ kind: 'lost' }).expect(201);
    await ceo.post(`/api/jersey-updates/${(await pendingUpdates())[0].id}/confirm`).expect(200);
    expect(await mine()).toMatchObject({ given: 5, sold: 2, returned: 2, lostOrDamaged: 1, left: 0 });
  });
});

describe('stock requests', () => {
  const adam = request.agent(app);
  let adamId = 0, argentina = 0;
  const stockOf = async (v: number) => (await pool.query(`SELECT stock FROM variants WHERE id = $1`, [v])).rows[0].stock as number;
  const myRequests = async () => (await adam.get('/api/stock-requests').expect(200)).body as any[];
  const pendingRequests = async () => (await ceo.get('/api/stock-requests?status=pending').expect(200)).body as any[];

  beforeAll(async () => {
    await adam.post('/api/auth/login').send({ username: 'adam', password: 'adam-pass1' }).expect(200);
    adamId = (await adam.get('/api/auth/me')).body.id;
    argentina = (await pool.query(`SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE p.team = 'Argentina'`)).rows[0].id;
  });

  it('cannot ask for more than main stock has, or list a jersey twice', async () => {
    const stock = await stockOf(argentina);
    const tooMany = await adam.post('/api/stock-requests').send({ items: [{ variantId: argentina, quantity: stock + 1 }] }).expect(400);
    expect(tooMany.body.error).toContain(`Only ${stock}`);
    // Without permission to see stock counts, the error doesn't give the number away
    await pool.query(`UPDATE users SET can_see_stock = FALSE WHERE id = $1`, [adamId]);
    const hidden = await adam.post('/api/stock-requests').send({ items: [{ variantId: argentina, quantity: stock + 1 }] }).expect(400);
    expect(hidden.body.error).not.toMatch(/\d/);
    await pool.query(`UPDATE users SET can_see_stock = TRUE WHERE id = $1`, [adamId]);
    await adam.post('/api/stock-requests').send({ items: [{ variantId: argentina, quantity: 1 }, { variantId: argentina, quantity: 1 }] }).expect(400);
    await adam.post('/api/stock-requests').send({ items: [] }).expect(400);
  });

  it('an associate asks for jerseys: nothing moves, the CEO is notified and sees it in Pending Approvals', async () => {
    const before = await stockOf(argentina);
    await adam.post('/api/stock-requests').send({
      items: [{ variantId: argentina, quantity: 3 }, { variantId, quantity: 2 }], note: 'Tournament on Saturday',
    }).expect(201);
    expect(await stockOf(argentina)).toBe(before);
    expect((await bell(ceo))[0].kind).toBe('stock_request');
    const [r] = await pendingRequests();
    expect(r).toMatchObject({ associateName: 'Adam Rossi', note: 'Tournament on Saturday', status: 'pending' });
    expect(r.items.map((i: any) => i.quantity)).toEqual([3, 2]);
    expect((await myRequests())[0].status).toBe('pending');
  });

  it('the CEO can lower amounts (not raise them), then hands them over as jerseys in hand', async () => {
    const [r] = await pendingRequests();
    const [arg, bra] = r.items;
    const argBefore = await stockOf(argentina), braBefore = await stockOf(variantId);
    await ceo.post(`/api/stock-requests/${r.id}/approve`).send({ items: [{ itemId: arg.id, quantity: 4 }] }).expect(400);
    await ceo.post(`/api/stock-requests/${r.id}/approve`).send({ items: [{ itemId: arg.id, quantity: 0 }, { itemId: bra.id, quantity: 0 }] }).expect(400);
    await ceo.post(`/api/stock-requests/${r.id}/approve`).send({ items: [{ itemId: arg.id, quantity: 2 }, { itemId: bra.id, quantity: 0 }] }).expect(200);

    expect(await stockOf(argentina)).toBe(argBefore - 2);
    expect(await stockOf(variantId)).toBe(braBefore);
    const [h] = await myJerseys(adam);
    expect(h).toMatchObject({ quantity: 2, team: 'Argentina' });
    expect(Math.abs(new Date(h.dueAt).getTime() - (Date.now() + 30 * 864e5))).toBeLessThan(864e5); // due back in 30 days
    expect((await bell(adam))[0].kind).toBe('stock_request_approved');
    expect((await myRequests())[0]).toMatchObject({ status: 'approved', items: [{ quantity: 3, approved: 2 }, { quantity: 2, approved: 0 }] });
    await ceo.post(`/api/stock-requests/${r.id}/approve`).expect(409); // only once
    expect((await adam.get('/api/in-hand/mine')).body).toMatchObject({ given: 7, left: 2 });
  });

  it('declining hands nothing over and tells the associate', async () => {
    const before = await stockOf(argentina);
    await adam.post('/api/stock-requests').send({ items: [{ variantId: argentina, quantity: 1 }] }).expect(201);
    const [r] = await pendingRequests();
    await ceo.post(`/api/stock-requests/${r.id}/decline`).expect(200);
    expect(await stockOf(argentina)).toBe(before);
    expect((await bell(adam))[0].kind).toBe('stock_request_declined');
    expect((await myRequests())[0].status).toBe('declined');
  });

  it('only associates ask, only the CEO decides, and associates only see their own', async () => {
    await ceo.post('/api/stock-requests').send({ items: [{ variantId: argentina, quantity: 1 }] }).expect(403);
    const [r] = await myRequests();
    await adam.post(`/api/stock-requests/${r.id}/approve`).expect(403);
    await adam.post(`/api/stock-requests/${r.id}/decline`).expect(403);
    expect((await omar.get('/api/stock-requests').expect(200)).body).toEqual([]);
  });

  it('every request, approval and decline is in the Activity Log', async () => {
    const actions = (await ceo.get('/api/activity')).body.entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['stock_request_made', 'stock_request_approved', 'stock_request_declined']));
  });

  it('the Dashboard counts pending sales, jersey updates and stock requests', async () => {
    const before = (await ceo.get('/api/dashboard/owner')).body;
    await adam.post('/api/sales').send({ source: 'in_hand', paymentMethod: 'cash', customerName: 'Z', items: [{ variantId: argentina, quantity: 1 }] }).expect(201);
    const [h] = await myJerseys(adam);
    await adam.post(`/api/in-hand/${h.id}/updates`).send({ kind: 'damaged', quantity: 1 }).expect(201);
    await adam.post('/api/stock-requests').send({ items: [{ variantId: argentina, quantity: 1 }] }).expect(201);
    const after = (await ceo.get('/api/dashboard/owner')).body;
    expect(after.pendingApprovals).toBe(before.pendingApprovals + 1);
    expect(after.pendingJerseyUpdates).toBe(before.pendingJerseyUpdates + 1);
    expect(after.pendingStockRequests).toBe(before.pendingStockRequests + 1);
  });
});

describe('WhatsApp orders', () => {
  const whatsappSale = { source: 'stock', paymentMethod: 'etransfer', whatsapp: true, customerName: 'Lina', customerEmail: 'lina@example.com' };

  it('take $5 off every jersey: the quote, revenue and profit all show it, cost and shipping do not change', async () => {
    const items = [{ variantId, quantity: 2 }];
    const quote = (await yusuf.post('/api/sales/quote').send({ ...whatsappSale, items }).expect(200)).body;
    expect(quote).toMatchObject({ whatsappDiscount: 10, revenue: 80, shipping: 6, total: 86 }); // 2 × $45 − $10, plus $6 shipping

    const r = await yusuf.post('/api/sales').send({ ...whatsappSale, items }).expect(201);
    await ceo.post(`/api/sales/${r.body.id}/approve`).expect(200);
    const sale = (await ceo.get('/api/sales?status=approved')).body.find((s: any) => s.id === r.body.id);
    expect(sale).toMatchObject({ whatsappDiscount: 10, revenue: 80, cost: 36, profit: 44, shipping: 6 });
    // Associates see the discount on their own sale, but still no cost or profit
    const mine = (await yusuf.get('/api/sales')).body.find((s: any) => s.id === r.body.id);
    expect(mine.whatsappDiscount).toBe(10);
    expect(mine.profit).toBeUndefined();
    // A normal order has no discount
    const plain = (await yusuf.post('/api/sales/quote').send({ ...whatsappSale, whatsapp: false, items }).expect(200)).body;
    expect(plain).toMatchObject({ whatsappDiscount: 0, revenue: 90 });
  });

  it('the discount is a setting the CEO can change, and it appears in the sales export', async () => {
    const s = (await ceo.get('/api/settings').expect(200)).body;
    expect(s.whatsappDiscount).toBe(5);
    await ceo.put('/api/settings').send({ ...s, whatsappDiscount: 7 }).expect(200);
    const quote = (await yusuf.post('/api/sales/quote').send({ ...whatsappSale, items: [{ variantId, quantity: 1 }] })).body;
    expect(quote.whatsappDiscount).toBe(7);
    await ceo.put('/api/settings').send({ ...s, whatsappDiscount: -1 }).expect(400);
    await ceo.put('/api/settings').send(s).expect(200);
    const csv = (await ceo.get('/api/reports/sales.csv').expect(200)).text;
    expect(csv.split('\n')[0]).toContain('whatsapp_discount');
  });
});

describe('recruiter demo', () => {
  it('on the demo, nobody can reset an associate\'s password or remove them (it would break the one-click logins)', async () => {
    process.env.DEMO_MODE = 'true';
    try {
      const reset = await ceo.post(`/api/team/${yusufId}/password`).send({ password: 'new-pass-123' }).expect(403);
      expect(reset.body.error).toContain('turned off in the demo');
      await ceo.post(`/api/team/${yusufId}/confirm-removal`).expect(403);
    } finally {
      delete process.env.DEMO_MODE;
    }
    await yusuf.get('/api/dashboard/me').expect(200); // still on the team
  });
});

describe('going online safely', () => {
  it('the wrong-password limit locks a key for 15 minutes after 10 tries, then lets it try again', () => {
    let t = 0;
    const limiter = createLoginLimiter({ now: () => t });
    for (let i = 1; i <= 9; i++) expect(limiter.fail('ip|yassin')).toBe(false);
    expect(limiter.waitMinutes('ip|yassin')).toBe(0);
    expect(limiter.fail('ip|yassin')).toBe(true); // the 10th starts the lockout
    expect(limiter.waitMinutes('ip|yassin')).toBe(15);
    expect(limiter.waitMinutes('ip|omar')).toBe(0); // other people are unaffected
    t += 15 * 60 * 1000;
    expect(limiter.waitMinutes('ip|yassin')).toBe(0);
  });

  it("uses Railway's X-Real-IP for the visitor's address, and ignores that header anywhere else", () => {
    const req = (headers: Record<string, string>) => ({ ip: '100.64.0.7', get: (h: string) => headers[h.toLowerCase()] }) as any;
    expect(clientIp(req({ 'x-real-ip': '142.114.233.6' }))).toBe('100.64.0.7'); // not on Railway: could be faked
    process.env.RAILWAY_SERVICE_ID = 'test';
    try {
      expect(clientIp(req({ 'x-real-ip': '142.114.233.6' }))).toBe('142.114.233.6');
      expect(clientIp(req({}))).toBe('100.64.0.7');
    } finally {
      delete process.env.RAILWAY_SERVICE_ID;
    }
  });

  it('refuses to start online with missing or example secrets', () => {
    const good = { NODE_ENV: 'production', DATABASE_URL: 'postgres://x', JWT_SECRET: 'a'.repeat(64), OWNER_PASSWORD: 'a-long-password' };
    expect(() => checkProductionEnv(good)).not.toThrow();
    expect(() => checkProductionEnv({ ...good, JWT_SECRET: 'change-me-to-a-long-random-string' })).toThrow(/JWT_SECRET/);
    expect(() => checkProductionEnv({ ...good, OWNER_PASSWORD: 'change-me' })).toThrow(/OWNER_PASSWORD/);
    expect(() => checkProductionEnv({ ...good, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => checkProductionEnv({ NODE_ENV: 'development' })).not.toThrow(); // only checked online
  });

  // Runs last: it locks the CEO's username out for this test run.
  it('after 10 wrong passwords even the right one waits; other people can still log in', async () => {
    const attempt = (username: string, password: string) => request(app).post('/api/auth/login').send({ username, password });
    for (let i = 0; i < 10; i++) await attempt('yassin', 'wrong-guess').expect(401);
    const blocked = await attempt('yassin', 'ceo-pass-1').expect(429);
    expect(blocked.body.error).toMatch(/Try again in 15 minutes/);
    await attempt('omar', 'omar-pass1').expect(200);
    const log = (await ceo.get('/api/activity')).body.entries;
    expect(log.some((e: any) => e.action === 'login_blocked' && e.details.username === 'yassin')).toBe(true);
  });
});
