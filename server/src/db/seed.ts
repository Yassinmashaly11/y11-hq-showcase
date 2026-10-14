import { pathToFileURL } from 'node:url';
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool, tx } from './pool.js';
import { migrate } from './migrate.js';
import { DEFAULT_SETTINGS } from '../domain/settings.js';
import { saveSettings } from '../services/settings.js';
import { createSale, approveSale, rejectSale } from '../services/sales.js';
import { checkProductionEnv } from '../env.js';
import { recordWebsiteOrder } from '../services/website-orders.js';
import { requestUpdate } from '../services/in-hand.js';
import { createStockRequest } from '../services/stock-requests.js';

// Starting jersey types for a new database. Prices are the shop's; the costs are made-up starting
// values. Enter your real supplier costs in Settings → Jersey prices (your real database keeps its own).
const TYPES = [
  { code: 'fan_short', name: 'Short sleeve (fan)', price: 45, cost: 18 },
  { code: 'player_short', name: 'Short sleeve (player)', price: 45, cost: 24 },
  { code: 'fan_long', name: 'Long sleeve (fan)', price: 50, cost: 22 },
  { code: 'player_long', name: 'Long sleeve (player)', price: 50, cost: 28 },
  { code: 'retro_short', name: 'Retro short sleeve', price: 50, cost: 24 },
  { code: 'retro_long', name: 'Retro long sleeve', price: 55, cost: 29 },
];

const daysAgo = (n: number, hour = 14) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, 0, 0, 0);
  return d;
};

async function seedBase() {
  for (const t of TYPES) {
    await pool.query(
      `INSERT INTO product_types (code, name, price, cost) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING`,
      [t.code, t.name, t.price, t.cost],
    );
  }
  await pool.query(`INSERT INTO settings (key, value) VALUES ('business', $1) ON CONFLICT DO NOTHING`, [JSON.stringify(DEFAULT_SETTINGS)]);

  const username = (process.env.OWNER_USERNAME ?? 'yassin').toLowerCase();
  const password = process.env.OWNER_PASSWORD;
  if (!password) throw new Error('Set OWNER_PASSWORD in server/.env first');
  const exists = await pool.query(`SELECT 1 FROM users WHERE role = 'owner'`);
  if (!exists.rowCount) {
    await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role) VALUES ($1,$2,'Yassin Mashaly','owner')`,
      [username, await bcrypt.hash(password, 10)],
    );
    console.log(`CEO login created: ${username}`);
  }
}

// ---------- Fake data so every screen has something to show ----------

const DEMO_JERSEYS: [string, string, string, string][] = [
  ['Real Madrid', 'Home', '25/26', 'fan_short'],
  ['Real Madrid', 'Away', '25/26', 'fan_short'],
  ['Barcelona', 'Home', '25/26', 'fan_short'],
  ['Arsenal', 'Home', '25/26', 'player_short'],
  ['Brazil', 'Home', '2026', 'fan_short'],
  ['Argentina', 'Home', '2026', 'fan_short'],
  ['Spain', 'Home', '2026', 'fan_short'],
  ['Portugal', 'Away', '2026', 'fan_long'],
  ['AC Milan', 'Home', '06/07', 'retro_short'],
  ['Manchester United', 'Home', '98/99', 'retro_long'],
  ['Liverpool', 'Home', '25/26', 'player_long'],
];
const SIZES = ['S', 'M', 'L', 'XL', '2XL'];

async function seedDemo() {
  const has = await pool.query(`SELECT 1 FROM products LIMIT 1`);
  if (has.rowCount) return console.log('Demo data already loaded, skipping.');

  const owner = (await pool.query(`SELECT id FROM users WHERE role = 'owner'`)).rows[0];
  const ownerActor = { id: owner.id, role: 'owner' as const };
  const types = new Map((await pool.query(`SELECT id, code FROM product_types`)).rows.map((r) => [r.code, r.id]));

  // Catalog with plenty of stock
  const variantIds: number[] = [];
  for (const [i, [team, kit, season, type]] of DEMO_JERSEYS.entries()) {
    const p = await pool.query(`INSERT INTO products (team, kit, season, type_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [team, kit, season, types.get(type)]);
    for (const size of SIZES) {
      const stock = size === '2XL' ? 2 : 8 + ((i * 3 + size.length) % 7);
      const v = await pool.query(`INSERT INTO variants (product_id, size, stock) VALUES ($1,$2,$3) RETURNING id`, [p.rows[0].id, size, stock]);
      if (size !== '2XL') variantIds.push(v.rows[0].id);
    }
  }
  const pick = (n: number) => variantIds[(n * 7) % variantIds.length];

  // Three demo associates, all with password "demo1234"
  const hash = await bcrypt.hash('demo1234', 10);
  const mk = async (username: string, name: string, joinedDaysAgo: number) =>
    (await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role, created_at, period_start, referral_code)
       VALUES ($1,$2,$3,'associate',$4,$4,$1) RETURNING id`,
      [username, hash, name, daysAgo(joinedDaysAgo, 9)],
    )).rows[0].id as number;
  const yusuf = await mk('yusuf', 'Yusuf Ahmed', 45);
  const omar = await mk('omar', 'Omar Khalil', 40);
  const adam = await mk('adam', 'Adam Rossi', 10);

  // Give each of them jerseys to carry
  for (const [aid, n] of [[yusuf, 6], [omar, 4], [adam, 3]] as const) {
    for (let k = 0; k < n; k++) {
      const v = pick(aid * 10 + k);
      await pool.query(`UPDATE variants SET stock = stock - 1 WHERE id = $1`, [v]);
      await pool.query(`INSERT INTO in_hand (associate_id, variant_id, quantity, assigned_at, due_at)
                        VALUES ($1,$2,1,$3,$3::timestamptz + interval '30 days')`, [aid, v, daysAgo(k < 2 && aid !== adam ? 35 : 6)]);
    }
  }

  // Sales history: [associateId or null, days ago, jerseys, payment, name & number?]
  const history: [number | null, number, number, 'etransfer' | 'cash', boolean][] = [];
  for (let d = 42; d >= 1; d--) {
    if (d % 2 === 0) history.push([yusuf, d, d % 6 === 0 ? 2 : 1, d % 4 === 0 ? 'cash' : 'etransfer', d % 5 === 0]);
    if (d % 3 === 0) history.push([omar, d, 1, 'etransfer', false]);
    if (d % 4 === 1) history.push([null, d, d % 8 === 1 ? 4 : 1, 'etransfer', d % 8 === 1]);
    if (d <= 9 && d % 3 === 1) history.push([adam, d, 1, 'cash', false]);
  }

  let n = 0;
  for (const [aid, ago, qty, pay, nn] of history) {
    n++;
    const when = daysAgo(ago, 11 + (n % 8));
    await tx(async (c) => {
      const actor = aid ? { id: aid, role: 'associate' as const } : ownerActor;
      const saleId = await createSale(c, actor, {
        source: 'stock', paymentMethod: pay,
        customerName: ['Karim B.', 'Daniel P.', 'Sara M.', 'Leo T.', 'Nadia H.', 'Chris O.'][n % 6],
        customerEmail: pay === 'etransfer' ? `customer${n}@example.com` : undefined,
        items: [{ variantId: pick(n), quantity: qty, nameNumber: nn, customText: nn ? 'MESSI 10' : undefined }],
      }, when);
      if (aid) {
        const decided = new Date(when.getTime() + 3 * 3600 * 1000);
        if (n % 17 === 0) await rejectSale(c, saleId, ownerActor, 'No matching e-Transfer found', decided);
        else await approveSale(c, saleId, ownerActor, decided);
      }
    });
  }

  // A few sales waiting for approval
  await tx(async (c) => {
    await createSale(c, { id: yusuf, role: 'associate' }, {
      source: 'in_hand', paymentMethod: 'etransfer', customerName: 'Mohamed S.', customerEmail: 'mo.s@example.com',
      items: [{ variantId: (await c.query(`SELECT variant_id FROM in_hand WHERE associate_id = $1 AND quantity > 0 LIMIT 1`, [yusuf])).rows[0].variant_id, quantity: 1 }],
    });
    await createSale(c, { id: omar, role: 'associate' }, {
      source: 'stock', paymentMethod: 'etransfer', customerName: 'Jake W.', customerEmail: 'jake.w@example.com',
      items: [{ variantId: pick(3), quantity: 2, nameNumber: true, customText: 'SAKA 7' }],
    });
  });

  // Cash Yusuf already handed over
  await pool.query(`INSERT INTO cash_ledger (associate_id, amount, note, created_at) VALUES ($1, -100, 'Handed to CEO', $2)`, [yusuf, daysAgo(5)]);

  // Shifts
  for (const [aid, count] of [[yusuf, 14], [omar, 9], [adam, 4]] as const) {
    for (let k = 0; k < count; k++) {
      const start = daysAgo(k * 3 + 1, 12 + (k % 4));
      await pool.query(`INSERT INTO shifts (user_id, started_at, ended_at) VALUES ($1,$2,$2::timestamptz + interval '3 hours 30 minutes')`, [aid, start]);
    }
  }
  // ----- Phase 2 demo data -----
  const ownerId = owner.id;
  // Yusuf was paid for his first month
  await tx(async (c) => {
    const due = await c.query(`SELECT id, amount FROM commission_earnings WHERE associate_id = $1 AND created_at < $2`, [yusuf, daysAgo(20)]);
    const total = due.rows.reduce((n, r) => n + r.amount, 0);
    if (total > 0) {
      const p = await c.query(`INSERT INTO payouts (associate_id, amount, method, note, paid_at, created_by) VALUES ($1,$2,'etransfer','First month',$3,$4) RETURNING id`,
        [yusuf, total, daysAgo(19), ownerId]);
      await c.query(`UPDATE commission_earnings SET paid_at = $2, payout_id = $3 WHERE id = ANY($1)`, [due.rows.map((r) => r.id), daysAgo(19), p.rows[0].id]);
    }
  });
  for (const [aid, code] of [[yusuf, 'YUSUF10'], [yusuf, 'YUSUFSUMMER'], [omar, 'OMAR7'], [adam, 'ADAM9']] as const) {
    await pool.query(`INSERT INTO promo_codes (associate_id, code, created_at) VALUES ($1,$2,$3)`, [aid, code, daysAgo(30)]);
  }
  await pool.query(`INSERT INTO announcements (title, body, pinned, created_by, created_at) VALUES
    ('New Arsenal and Liverpool kits in stock', 'Sizes S to XL. Ask me for in-hand jerseys if you have buyers lined up.', FALSE, $1, $2),
    ('How payouts work', 'I pay commission every two weeks by e-Transfer. Check My Payouts for your statement.', TRUE, $1, $3)`, [ownerId, daysAgo(2), daysAgo(25)]);
  const expenses: [string, string, number, number][] = [
    ['Ads', 'Instagram ads', 60, 28], ['Packaging', 'Poly mailers x100', 35, 26], ['Website & domain', 'y11jerseys.com renewal', 25, 20],
    ['Ads', 'TikTok promo', 40, 12], ['Payment fees', 'Stripe fees (Sept)', 18, 8], ['Supplies', 'Printer labels', 15, 4],
  ];
  for (const [category, description, amount, ago] of expenses) {
    await pool.query(`INSERT INTO expenses (category, description, amount, spent_at, created_by) VALUES ($1,$2,$3,$4::date,$5)`,
      [category, description, amount, daysAgo(ago).toISOString().slice(0, 10), ownerId]);
  }
  // ----- Phase 3 demo data -----
  // A WhatsApp order you logged yourself ($5 off each jersey)
  await tx((c) => createSale(c, ownerActor, {
    source: 'stock', paymentMethod: 'etransfer', whatsapp: true, customerName: 'Ali R.', customerEmail: 'ali.r@example.com',
    items: [{ variantId: pick(40), quantity: 2 }],
  }, daysAgo(3, 15)));
  // Two paid website orders (made to order, so no stock moves): one through Yusuf's code, one nobody referred
  const shipTo = (name: string, line1: string, city: string, postal: string) => ({ name, line1, city, province: 'ON', postal, country: 'CA' });
  await tx((c) => recordWebsiteOrder(c, {
    stripeSessionId: 'cs_demo_1', environment: 'live',
    customer: { name: 'Hassan K.', email: 'hassan.k@example.com', phone: '+1 416 555 0142' },
    shipTo: shipTo('Hassan K.', '220 King St W', 'Toronto', 'M5H 1K4'),
    totalPaid: 119, tax: 13, shipping: 6, promoCode: 'YUSUF10',
    items: [
      { title: 'Real Madrid Home', team: 'Real Madrid', kit: 'Home', season: '2026/27', size: 'M', quantity: 1, kind: 'short', name: 'BELLINGHAM', number: '5' },
      { title: 'Argentina Home', team: 'Argentina', kit: 'Home', season: '2026', size: 'L', quantity: 1, kind: 'short' },
    ],
  }, daysAgo(2, 13)));
  await tx((c) => recordWebsiteOrder(c, {
    stripeSessionId: 'cs_demo_2', environment: 'live',
    customer: { name: 'Emily R.', email: 'emily.r@example.com', phone: '+1 647 555 0199' },
    shipTo: shipTo('Emily R.', '88 Lakeshore Rd E', 'Mississauga', 'L5G 1E2'),
    totalPaid: 175.15, tax: 20.15, shipping: 0, // $45 + $55 (2XL) + $55 (retro with patch), 13% tax
    items: [
      { title: 'Brazil Home', team: 'Brazil', kit: 'Home', season: '2026', size: 'M', quantity: 1, kind: 'short' },
      { title: 'Portugal Eusébio Special Long Sleeve', team: 'Portugal', kit: 'Special', season: '2026', size: '2XL', quantity: 1, kind: 'long' },
      { title: 'AC Milan 06/07 Home', team: 'AC Milan', kit: 'Retro', season: '2006/07', version: 'Retro Reproduction', size: 'S', quantity: 1, kind: 'retro_short', patch: true },
    ],
  }, daysAgo(1, 19)));
  // Waiting for you in Pending Approvals: Yusuf says he returned a jersey, and Omar asks for more stock
  const yusufJersey = (await pool.query(`SELECT id FROM in_hand WHERE associate_id = $1 AND quantity > 0 ORDER BY assigned_at DESC LIMIT 1`, [yusuf])).rows[0];
  if (yusufJersey) await tx((c) => requestUpdate(c, yusuf, yusufJersey.id, { kind: 'returned', note: 'Gave it back at practice' }));
  await tx((c) => createStockRequest(c, omar, [{ variantId: pick(5), quantity: 2 }, { variantId: pick(6), quantity: 1 }], 'Tournament this weekend'));

  // Seeding created a notification for every past sale; keep only a realistic few.
  await pool.query(`DELETE FROM notifications WHERE kind IN ('sale_approved', 'sale_rejected', 'sale_pending', 'low_stock')`);
  await pool.query(`INSERT INTO notifications (user_id, kind, message, link)
                    SELECT $1, 'sale_pending', 'You have sales waiting for approval.', '/approvals'`, [ownerId]);

  console.log(`Demo data loaded: ${history.length} past sales, 3 associates (yusuf / omar / adam, password demo1234).`);
}

/** Wipe everything and start again. Used by `npm run db:reset` and the nightly demo reset. */
export async function seedAll({ reset }: { reset: boolean }) {
  checkProductionEnv(); // before the CEO login is created from OWNER_PASSWORD
  if (reset) {
    await pool.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    console.log('Database wiped.');
  }
  await migrate();
  await seedBase();
  if (process.env.SEED_DEMO_DATA === 'true') await seedDemo();
}

/**
 * A one-time wipe on Railway that never makes the database public: set the variable RESET_DATABASE to
 * "delete-everything-<anything>" and deploy. HQ runs this seed on every start; the wipe happens once
 * per value, because the value is remembered in the fresh database, so restarts can't repeat it.
 * Remove the variable afterwards. Returns true if it wiped.
 */
export async function runRequestedReset(): Promise<boolean> {
  const token = (process.env.RESET_DATABASE ?? '').trim();
  if (!token) return false;
  if (!token.startsWith('delete-everything-')) {
    console.warn('RESET_DATABASE ignored: the value must start with "delete-everything-".');
    return false;
  }
  const done = await pool.query(`SELECT value FROM settings WHERE key = 'last_reset'`).catch(() => ({ rows: [] as { value: { token?: string } }[] }));
  if (done.rows[0]?.value?.token === token) {
    console.log('RESET_DATABASE was already done for this value, so nothing was wiped. You can remove the variable.');
    return false;
  }
  await seedAll({ reset: true });
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('last_reset', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify({ token, at: new Date().toISOString() })],
  );
  await pool.query(`INSERT INTO activity_log (actor_id, action, details) VALUES (NULL, 'database_reset', $1)`, [JSON.stringify({ how: 'RESET_DATABASE' })]);
  console.log('RESET_DATABASE: the database was wiped and set up fresh. Remove the RESET_DATABASE variable now.');
  return true;
}

// Run directly (npm run db:..., and on every start of the Docker box), not when imported.
// pathToFileURL handles spaces in folder names.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  (async () => {
    if (await runRequestedReset()) return;
    await seedAll({ reset: process.argv.includes('--reset') });
  })()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => pool.end());
}
