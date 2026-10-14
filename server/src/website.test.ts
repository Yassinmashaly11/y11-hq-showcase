import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createApp } from './app.js';
import { pool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { DEFAULT_SETTINGS } from './domain/settings.js';

// The website API: promo code / referral checks, and paid website orders recorded in HQ.
const KEY = 'test-website-key-0123456789abcdef0123456789';
process.env.WEBSITE_API_KEY = KEY;
const app = createApp();
const ceo = request.agent(app);
const yusuf = request.agent(app);
const site = {
  get: (path: string) => request(app).get(`/api/website${path}`).set('Authorization', `Bearer ${KEY}`),
  post: (path: string, body: object) => request(app).post(`/api/website${path}`).set('Authorization', `Bearer ${KEY}`).send(body),
};
let yusufId = 0, omarId = 0, brazilM = 0;

// Two jerseys: Real Madrid Home M with TEST 10 ($45 + $10 = $55) and a long sleeve 2XL with a patch ($50 + $5 + $5 = $60).
// 2 jerseys = $6 shipping. With $15.73 tax the customer paid $136.73; revenue is $115, cost $21 + $26 = $47 (sample costs).
let n = 0;
const order = (over: Record<string, unknown> = {}) => ({
  stripeSessionId: `cs_test_${++n}`,
  environment: 'live',
  customer: { name: 'Karim Ahmed', email: 'karim@example.com', phone: '+1 416 555 0100' },
  shipTo: { name: 'Karim Ahmed', line1: '100 Queen St W', line2: 'Apt 4', city: 'Toronto', province: 'ON', postal: 'M5H 2N2', country: 'CA' },
  totalPaid: 136.73, tax: 15.73, shipping: 6,
  items: [
    { productId: 'p1', title: 'Real Madrid Home', team: 'Real Madrid', kit: 'Home', season: '2026/27', size: 'M', quantity: 1, kind: 'short', name: 'TEST', number: '10', patch: false },
    { productId: 'p161', title: 'Portugal Eusébio Special Long Sleeve', team: 'Portugal', kit: 'Special', season: '2026', size: '2XL', quantity: 1, kind: 'long', patch: true },
  ],
  ...over,
});
const oneJersey = { totalPaid: 53, tax: 0, shipping: 8, items: [{ title: 'Brazil Home', team: 'Brazil', kit: 'Home', size: 'L', quantity: 1, kind: 'short' }] };
const sales = async () => (await ceo.get('/api/sales')).body as any[];
const saleById = async (id: number) => (await sales()).find((s) => s.id === id);

beforeAll(async () => {
  await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  await migrate();
  await pool.query(`INSERT INTO settings (key, value) VALUES ('business', $1)`, [JSON.stringify(DEFAULT_SETTINGS)]);
  await pool.query(`INSERT INTO product_types (code, name, price, cost) VALUES
    ('fan_short', 'Short sleeve (fan)', 45, 18), ('fan_long', 'Long sleeve (fan)', 50, 22)`);
  await pool.query(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('yassin', $1, 'Yassin', 'owner')`, [await bcrypt.hash('ceo-pass-1', 4)]);
  await ceo.post('/api/auth/login').send({ username: 'yassin', password: 'ceo-pass-1' }).expect(200);
  const p = await ceo.post('/api/products').send({ team: 'Brazil', kit: 'Home', typeId: 1, sizes: [{ size: 'M', stock: 10 }] });
  brazilM = (await pool.query(`SELECT id FROM variants WHERE product_id = $1`, [p.body.id])).rows[0].id;
  yusufId = (await ceo.post('/api/team').send({ fullName: 'Yusuf Ahmed', username: 'yusuf', password: 'yusuf-pass' })).body.id;
  omarId = (await ceo.post('/api/team').send({ fullName: 'Omar Khalil', username: 'omar', password: 'omar-pass1' })).body.id;
  await yusuf.post('/api/auth/login').send({ username: 'yusuf', password: 'yusuf-pass' }).expect(200);
  await ceo.post('/api/promo-codes').send({ associateId: yusufId, code: 'YUSUF10' }).expect(201);
  await ceo.post('/api/promo-codes').send({ associateId: omarId, code: 'OMAR7' }).expect(201);
});
afterEach(() => { vi.restoreAllMocks(); delete process.env.RESEND_API_KEY; delete process.env.ORDER_EMAIL_TO; });
afterAll(() => pool.end());

describe('website key and code checks', () => {
  it('only answers with the right key', async () => {
    await request(app).get('/api/website/promo-codes/YUSUF10').expect(401);
    await request(app).get('/api/website/promo-codes/YUSUF10').set('Authorization', 'Bearer wrong').expect(401);
    await yusuf.post('/api/website/orders').send(order()).expect(401); // a logged-in associate isn't the website
    delete process.env.WEBSITE_API_KEY;
    await site.get('/promo-codes/YUSUF10').expect(503); // not set up yet
    process.env.WEBSITE_API_KEY = KEY;
  });

  it('checks promo codes and referral links in any letter case', async () => {
    expect((await site.get('/promo-codes/yusuf10')).body).toEqual({ valid: true, code: 'YUSUF10' });
    expect((await site.get('/promo-codes/NOPE')).body).toEqual({ valid: false });
    expect((await site.get('/referrals/Yusuf')).body).toEqual({ valid: true, code: 'yusuf' });
    expect((await site.get('/referrals/nobody')).body).toEqual({ valid: false });
  });

  it('the stock routes are gone: website orders are made to order', async () => {
    await site.get('/stock').expect(404);
    await site.post('/check-stock', { items: [{ variantId: brazilM, quantity: 1 }] }).expect(404);
  });
});

describe('recording paid website orders', () => {
  let saleId = 0;
  const first = order({ promoCode: 'yusuf10' });

  it('records the order as an approved website sale: revenue without tax or shipping, cost from your jersey types', async () => {
    const r = await site.post('/orders', first).expect(201);
    saleId = r.body.saleId;
    const sale = await saleById(saleId);
    expect(sale).toMatchObject({
      channel: 'website', paymentMethod: 'stripe', status: 'approved', soldBy: 'Yusuf Ahmed', customerName: 'Karim Ahmed',
      jerseyCount: 2, revenue: 115, cost: 47, profit: 68, shipping: 6, notes: null,
    });
    expect(sale.items).toEqual([
      { team: 'Real Madrid', kit: 'Home 2026/27', size: 'M', quantity: 1, nameNumber: true, customText: 'TEST 10', patch: false },
      { team: 'Portugal', kit: 'Special 2026', size: '2XL', quantity: 1, nameNumber: false, customText: null, patch: true },
    ]);
  });

  it('never touches stock', async () => {
    expect((await pool.query(`SELECT stock FROM variants WHERE id = $1`, [brazilM])).rows[0].stock).toBe(10);
  });

  it('the same order sent twice is recorded once', async () => {
    const again = await site.post('/orders', first).expect(200);
    expect(again.body).toEqual({ saleId, duplicate: true });
    expect((await sales()).filter((s) => s.channel === 'website')).toHaveLength(1);
  });

  it('counts exactly like the associate\'s own sale: levels, commission and a notification', async () => {
    expect((await yusuf.get('/api/dashboard/me')).body).toMatchObject({ periodJerseys: 2, commissionEarned: 0 });
    // A third jersey through his referral link completes a set of 3: $24 at Level 1
    await site.post('/orders', order({ ...oneJersey, ref: 'Yusuf' })).expect(201);
    expect((await yusuf.get('/api/dashboard/me')).body).toMatchObject({ periodJerseys: 3, commissionEarned: 24 });
    const bell = (await yusuf.get('/api/notifications')).body.items;
    expect(bell[0]).toMatchObject({ kind: 'website_order' });
    expect(bell[0].message).toContain('your link');
    expect((await ceo.get('/api/notifications')).body.items[0].kind).toBe('website_order');
  });

  it('a typed promo code beats a referral link; unknown codes credit nobody and don\'t touch your leaderboard', async () => {
    const both = await site.post('/orders', order({ ...oneJersey, promoCode: 'OMAR7', ref: 'yusuf' })).expect(201);
    expect((await saleById(both.body.saleId)).soldBy).toBe('Omar Khalil');

    const ceoBefore = (await ceo.get('/api/leaderboard?range=all')).body.find((r: any) => r.role === 'owner').jerseys;
    const none = await site.post('/orders', order({ ...oneJersey, promoCode: 'FAKE', ref: 'nobody' })).expect(201);
    const sale = await saleById(none.body.saleId);
    expect(sale).toMatchObject({ soldBy: 'Website', associateId: null, status: 'approved' });
    expect((await ceo.get('/api/leaderboard?range=all')).body.find((r: any) => r.role === 'owner').jerseys).toBe(ceoBefore);
    const dash = (await ceo.get('/api/dashboard/owner?range=all')).body;
    expect(dash.byChannel.find((c: any) => c.channel === 'website').jerseys).toBe(5); // still counts in your revenue
  });

  it('flags an order whose charge doesn\'t match your HQ prices', async () => {
    const r = await site.post('/orders', order({ ...oneJersey, totalPaid: 58 })).expect(201); // $50 for a $45 jersey
    expect((await saleById(r.body.saleId)).notes).toContain('your HQ prices give $45.00');
  });

  it('Stripe test-mode orders only count while WEBSITE_TEST_ORDERS is on', async () => {
    const off = await site.post('/orders', order({ ...oneJersey, environment: 'sandbox' })).expect(200);
    expect(off.body.ignored).toMatch(/test-mode/);
    process.env.WEBSITE_TEST_ORDERS = 'true';
    const on = await site.post('/orders', order({ ...oneJersey, environment: 'sandbox' })).expect(201);
    delete process.env.WEBSITE_TEST_ORDERS;
    expect((await saleById(on.body.saleId)).notes).toContain('TEST MODE');
  });

  it('rejects orders that make no sense', async () => {
    await site.post('/orders', order({ items: [] })).expect(400);
    await site.post('/orders', order({ totalPaid: 5, tax: 3, shipping: 8 })).expect(400);
    await site.post('/orders', order({ environment: 'production' })).expect(400);
  });

  it('website sales are approved by HQ itself in the Activity Log', async () => {
    const log = (await ceo.get('/api/activity')).body.entries;
    expect(log.some((e: any) => e.action === 'website_order' && e.details.saleId === saleId)).toBe(true);
    expect(log.find((e: any) => e.action === 'sale_approved' && e.details.saleId === saleId).actor).toBe('Y11 HQ (automatic)');
  });
});

describe('Orders: what the supplier needs', () => {
  it('lists each website order with every jersey and the shipping address, ready to copy', async () => {
    const [first] = (await ceo.get('/api/website-orders?limit=100').expect(200)).body.slice(-1);
    expect(first).toMatchObject({ customerName: 'Karim Ahmed', jerseys: 2, promoCode: 'YUSUF10', associateName: 'Yusuf Ahmed', totalPaid: 136.73 });
    const text: string = first.supplierText;
    for (const part of [
      'Real Madrid Home 2026/27 · Size M', 'Team: Real Madrid · Kit: Home · Name: TEST · Number: 10 · Patch: no',
      'Portugal Eusébio Special Long Sleeve 2026 · Size 2XL', 'Name: none · Number: none · Patch: yes',
      'Ship to:\nKarim Ahmed\n100 Queen St W\nApt 4\nToronto, ON M5H 2N2\nCanada\nPhone: +1 416 555 0100',
    ]) expect(text).toContain(part);
  });

  it('only the CEO sees website orders; the associate sees the sale but not the customer\'s details', async () => {
    await yusuf.get('/api/website-orders').expect(403);
    const mine = (await yusuf.get('/api/sales')).body.find((s: any) => s.channel === 'website');
    expect(mine).toMatchObject({ customerName: 'Karim Ahmed', customerEmail: null });
    expect(mine.profit).toBeUndefined();
  });
});

describe('order emails', () => {
  const waitForCall = async (spy: ReturnType<typeof vi.fn>) => {
    for (let i = 0; i < 50 && !spy.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
  };

  it('emails you each new order with the supplier list, once it\'s set up', async () => {
    process.env.RESEND_API_KEY = 're_test';
    process.env.ORDER_EMAIL_TO = 'ceo@example.com';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"id":"x"}', { status: 200 }));
    const r = await site.post('/orders', order()).expect(201);
    await waitForCall(fetchSpy as any);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    const body = JSON.parse(String(init.body));
    expect(body.to).toEqual(['ceo@example.com']);
    expect(body.subject).toBe(`New website order #${r.body.saleId}: 2 jerseys for Karim Ahmed`);
    expect(body.text).toContain('Team: Real Madrid · Kit: Home · Name: TEST · Number: 10');
    expect(body.text).toContain('Toronto, ON M5H 2N2');
  });

  it('sends nothing until it\'s set up, and a failed email never loses the order', async () => {
    const quiet = vi.spyOn(globalThis, 'fetch');
    await site.post('/orders', order()).expect(201);
    await new Promise((r) => setTimeout(r, 100));
    expect(quiet).not.toHaveBeenCalled();

    process.env.RESEND_API_KEY = 're_test';
    process.env.ORDER_EMAIL_TO = 'ceo@example.com';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('email service down'));
    const r = await site.post('/orders', order()).expect(201);
    await waitForCall(failing as any);
    expect((await saleById(r.body.saleId)).status).toBe('approved');
    // ...and your bell says why the email didn't go
    let bell: any[] = [];
    for (let i = 0; i < 50 && !bell.some((n) => n.kind === 'email_failed'); i++) {
      await new Promise((res) => setTimeout(res, 20));
      bell = (await ceo.get('/api/notifications')).body.items;
    }
    expect(bell.find((n) => n.kind === 'email_failed').message).toContain(`order #${r.body.saleId}`);
  });

  it('Settings has a test email that shows the setup and Resend\'s exact answer', async () => {
    await yusuf.get('/api/settings/email-test').expect(403);

    const missing = (await ceo.get('/api/settings/email-test').expect(200)).body;
    expect(missing).toMatchObject({ sent: false, setup: { RESEND_API_KEY: 'NOT SET on the running server' } });
    expect(missing.meaning).toContain('Deploy');

    // Stray quotes and spaces around values are ignored
    process.env.RESEND_API_KEY = ' "re_abcdefgh1234" ';
    process.env.ORDER_EMAIL_TO = '"ceo@example.com" ';
    const testingOnly = '{"statusCode":403,"message":"You can only send testing emails to your own email address (owner@example.com).","name":"validation_error"}';
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(testingOnly, { status: 403 }));
    const refused = (await ceo.get('/api/settings/email-test').expect(200)).body;
    expect(refused).toMatchObject({ sent: false, resendStatus: 403, setup: { RESEND_API_KEY: 'set: 15 characters, re_…1234', ORDER_EMAIL_TO: 'ceo@example.com', from: 'Y11 HQ <onboarding@resend.dev>' } });
    expect(refused.resendSays).toContain('own email address');
    expect(refused.meaning).toContain('signed up to Resend with');
    const sent = JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent).toMatchObject({ from: 'Y11 HQ <onboarding@resend.dev>', to: ['ceo@example.com'] });
    expect((spy.mock.calls[0] as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer re_abcdefgh1234' });

    spy.mockResolvedValue(new Response('{"id":"abc"}', { status: 200 }));
    const ok = (await ceo.get('/api/settings/email-test').expect(200)).body;
    expect(ok).toMatchObject({ sent: true, resendStatus: 200 });
  });

  it('lists every EMAIL / ORDER / RESEND variable the server sees, so a lookalike name stands out', async () => {
    process.env.RESEND_API_KEY = 're_abcdefgh1234';
    process.env['ORDER_EMAIL_TO '] = 'ceo@example.com';   // trailing space in the name
    process.env['ORDER_EMAIL_T0'] = 'ceo@example.com';    // zero instead of the letter O
    try {
      const r = (await ceo.get('/api/settings/email-test').expect(200)).body;
      expect(r.setup.ORDER_EMAIL_TO).toBe('NOT SET on the running server');
      expect(r.setup.variablesSeen).toEqual(expect.arrayContaining([
        'ORDER_EMAIL_TO[space] (15 characters) ← looks like ORDER_EMAIL_TO but isn\'t exactly that name',
        'ORDER_EMAIL_T0 (15 characters) ← looks like ORDER_EMAIL_TO but isn\'t exactly that name',
        'RESEND_API_KEY (15 characters)',
      ]));
      expect(JSON.stringify(r)).not.toContain('ceo@example.com'); // lengths only, never values
    } finally {
      delete process.env['ORDER_EMAIL_TO '];
      delete process.env['ORDER_EMAIL_T0'];
    }
  });
});
