import pg from 'pg';
import { Db, pool } from '../db/pool.js';
import { cents, priceSale, PricingLine } from '../domain/pricing.js';
import { approveSale } from './sales.js';
import { getSettings } from './settings.js';
import { logActivity } from './activity.js';
import { notify, notifyOwner } from './notify.js';
import { sendEmail } from './email.js';

export type ShopKind = 'short' | 'long' | 'retro_short' | 'retro_long' | 'messi_farewell';

export interface WebsiteOrderInput {
  stripeSessionId: string;
  environment: 'live' | 'sandbox';
  customer: { name?: string; email?: string; phone?: string };
  shipTo: { name?: string; line1?: string; line2?: string; city?: string; province?: string; postal?: string; country?: string };
  totalPaid: number; // CAD, everything the customer paid
  tax: number;
  shipping: number;
  promoCode?: string;
  ref?: string;
  items: {
    productId?: string; title: string; team?: string; kit?: string; season?: string; version?: string;
    size: string; quantity: number; kind: ShopKind; name?: string; number?: string; patch?: boolean;
  }[];
}

/** The shop's jersey kinds, mapped onto your jersey types (Settings → Jersey prices) for the cost. */
function typeCodeFor(kind: ShopKind, version?: string) {
  const player = /player/i.test(version ?? '');
  switch (kind) {
    case 'short': return player ? 'player_short' : 'fan_short';
    case 'long': return player ? 'player_long' : 'fan_long';
    case 'retro_short': return 'retro_short';
    case 'retro_long': return 'retro_long';
    case 'messi_farewell': return 'fan_short';
  }
}

const dollars = (n: number) => `$${n.toFixed(2)}`;
const blank = (s?: string) => (s && s.trim() ? s.trim() : null);

/**
 * Record a paid website order as an approved "website" sale. Website orders are made to order, so no
 * stock moves. An associate whose promo code (first) or referral link brought the order gets it exactly
 * like their own sale: commission, level progress and milestone bonuses.
 */
export async function recordWebsiteOrder(c: pg.PoolClient, o: WebsiteOrderInput, now = new Date()) {
  const promo = blank(o.promoCode)?.toUpperCase() ?? null;
  const ref = blank(o.ref)?.toLowerCase() ?? null;

  // Each Stripe checkout is recorded once, however many times the shop sends it.
  const inserted = (await c.query(
    `INSERT INTO website_orders (stripe_session_id, environment, email, phone, ship_name, ship_line1, ship_line2, ship_city,
                                 ship_province, ship_postal, ship_country, total_paid, tax, shipping, promo_code, ref_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (stripe_session_id) DO NOTHING RETURNING id`,
    [o.stripeSessionId, o.environment, blank(o.customer.email), blank(o.customer.phone), blank(o.shipTo.name),
     blank(o.shipTo.line1), blank(o.shipTo.line2), blank(o.shipTo.city), blank(o.shipTo.province), blank(o.shipTo.postal),
     blank(o.shipTo.country), o.totalPaid, o.tax, o.shipping, promo, ref],
  )).rows[0];
  if (!inserted) {
    const existing = (await c.query(`SELECT sale_id FROM website_orders WHERE stripe_session_id = $1`, [o.stripeSessionId])).rows[0];
    return { saleId: existing.sale_id as number, duplicate: true };
  }

  // Who brought the order: a typed promo code beats a referral link. Only codes of people still on the team count.
  const byPromo = promo && (await c.query(
    `SELECT a.id, a.full_name FROM promo_codes p JOIN users a ON a.id = p.associate_id WHERE p.code = $1 AND p.active AND a.active`,
    [promo],
  )).rows[0];
  const byRef = !byPromo && ref && (await c.query(
    `SELECT id, full_name FROM users WHERE referral_code = $1 AND role = 'associate' AND active`, [ref],
  )).rows[0];
  const associate: { id: number; full_name: string } | undefined = byPromo || byRef || undefined;

  // Cost from your jersey types and extras; revenue is what the customer actually paid for the jerseys
  // (not tax, which goes to the government, or shipping, which goes to the supplier).
  const s = await getSettings(c);
  const types = new Map((await c.query(`SELECT code, price, cost FROM product_types`)).rows.map((t) => [t.code, t]));
  const lines: PricingLine[] = o.items.map((i) => {
    const t = types.get(typeCodeFor(i.kind, i.version)) ?? { price: 0, cost: 0 };
    return { size: i.size, quantity: i.quantity, typePrice: t.price, typeCost: t.cost, nameNumber: !!(blank(i.name) || blank(i.number)), patch: !!i.patch };
  });
  const priced = priceSale(lines, s, { chargeShipping: true });
  const revenue = cents(o.totalPaid - o.tax - o.shipping);
  const notes = [
    o.environment === 'sandbox' ? 'Stripe TEST MODE order (no real money).' : null,
    Math.abs(priced.revenue - revenue) > 0.01
      ? `The website charged ${dollars(revenue)} for the jerseys; your HQ prices give ${dollars(priced.revenue)}.` : null,
  ].filter(Boolean).join(' ') || null;

  const ownerId = (await c.query(`SELECT id FROM users WHERE role = 'owner' ORDER BY id LIMIT 1`)).rows[0].id as number;
  const customerName = blank(o.customer.name) ?? blank(o.shipTo.name) ?? 'Website customer';
  const saleId = (await c.query(
    `INSERT INTO sales (associate_id, channel, payment_method, customer_name, customer_email, created_by, created_at, notes,
                        jersey_count, squad_deal, revenue, cost, profit, shipping, promo_code)
     VALUES ($1,'website','stripe',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [associate?.id ?? null, customerName, blank(o.customer.email), ownerId, now, notes, priced.jerseyCount, priced.squadDeal,
     revenue, priced.cost, cents(revenue - priced.cost), o.shipping, byPromo ? promo : null],
  )).rows[0].id as number;

  for (const [n, i] of o.items.entries()) {
    await c.query(
      `INSERT INTO website_order_items (website_order_id, product_id, title, team, kit, season, version, size, quantity,
                                        print_name, print_number, patch, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [inserted.id, blank(i.productId), i.title, blank(i.team), blank(i.kit), blank(i.season), blank(i.version), i.size,
       i.quantity, blank(i.name), blank(i.number), !!i.patch, priced.lines[n].unitCost],
    );
  }
  await c.query(`UPDATE website_orders SET sale_id = $2 WHERE id = $1`, [inserted.id, saleId]);

  // Already paid by card, so it's approved right away. This is also what pays the associate (commission + levels).
  await approveSale(c, saleId, { id: ownerId, role: 'owner' }, now, { automatic: true });

  const jerseys = `${priced.jerseyCount} jersey${priced.jerseyCount === 1 ? '' : 's'}`;
  const via = associate ? ` (via ${associate.full_name}'s ${byPromo ? `code ${promo}` : 'link'})` : '';
  await notifyOwner(c, 'website_order', `New website order: ${jerseys}, ${dollars(o.totalPaid)} from ${customerName}${via}.`, '/orders');
  if (associate) {
    await notify(c, associate.id, 'website_order',
      `A website order came through your ${byPromo ? `code ${promo}` : 'link'}: ${jerseys}. It counts toward your level and payout.`, '/sales');
  }
  await logActivity(c, null, 'website_order', { saleId, jerseys: priced.jerseyCount, total: o.totalPaid, associateId: associate?.id ?? null });
  return { saleId, duplicate: false };
}

export interface WebsiteOrderView {
  saleId: number; createdAt: string; environment: 'live' | 'sandbox'; status: string;
  customerName: string; email: string | null; phone: string | null;
  shipTo: { name: string | null; line1: string | null; line2: string | null; city: string | null; province: string | null; postal: string | null; country: string | null };
  totalPaid: number; tax: number; shipping: number; promoCode: string | null; refCode: string | null;
  associateName: string | null; jerseys: number;
  items: { title: string; team: string | null; kit: string | null; season: string | null; version: string | null;
           size: string; quantity: number; name: string | null; number: string | null; patch: boolean }[];
  supplierText: string;
}

/** The order the way your supplier needs it: every jersey, then where to ship it. Shown in Orders and emailed to you. */
export function supplierText(o: Omit<WebsiteOrderView, 'supplierText'>): string {
  const out = [`Y11 website order #${o.saleId}${o.environment === 'sandbox' ? ' (TEST, not a real order)' : ''}`, `${o.jerseys} jersey${o.jerseys === 1 ? '' : 's'}`, ''];
  o.items.forEach((i, n) => {
    out.push(`${n + 1}. ${i.quantity > 1 ? `${i.quantity}× ` : ''}${i.title}${i.season ? ` ${i.season}` : ''}${i.version ? ` (${i.version})` : ''} · Size ${i.size}`);
    out.push(`   ${[
      i.team ? `Team: ${i.team}` : null, i.kit ? `Kit: ${i.kit}` : null,
      `Name: ${i.name ?? 'none'}`, `Number: ${i.number ?? 'none'}`, `Patch: ${i.patch ? 'yes' : 'no'}`,
    ].filter(Boolean).join(' · ')}`);
  });
  const t = o.shipTo;
  const cityLine = [t.city, [t.province, t.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  out.push('', 'Ship to:', ...[t.name ?? o.customerName, t.line1, t.line2, cityLine, t.country === 'CA' ? 'Canada' : t.country].filter((x): x is string => !!x));
  if (o.phone) out.push(`Phone: ${o.phone}`);
  return out.join('\n');
}

export async function listWebsiteOrders(db: Db, opts: { saleId?: number; limit?: number } = {}): Promise<WebsiteOrderView[]> {
  const r = await db.query(
    `SELECT o.*, s.customer_name, s.status, s.jersey_count, a.full_name AS associate_name,
            COALESCE(json_agg(json_build_object('title', w.title, 'team', w.team, 'kit', w.kit, 'season', w.season,
                     'version', w.version, 'size', w.size, 'quantity', w.quantity, 'name', w.print_name,
                     'number', w.print_number, 'patch', w.patch) ORDER BY w.id) FILTER (WHERE w.id IS NOT NULL), '[]') AS items
       FROM website_orders o JOIN sales s ON s.id = o.sale_id LEFT JOIN users a ON a.id = s.associate_id
       LEFT JOIN website_order_items w ON w.website_order_id = o.id
      ${opts.saleId ? 'WHERE o.sale_id = $1' : ''}
      GROUP BY o.id, s.id, a.full_name
      ORDER BY o.created_at DESC
      LIMIT ${Math.min(opts.limit ?? 50, 200)}`,
    opts.saleId ? [opts.saleId] : [],
  );
  return r.rows.map((x) => {
    const view: Omit<WebsiteOrderView, 'supplierText'> = {
      saleId: x.sale_id, createdAt: x.created_at, environment: x.environment, status: x.status,
      customerName: x.customer_name, email: x.email, phone: x.phone,
      shipTo: { name: x.ship_name, line1: x.ship_line1, line2: x.ship_line2, city: x.ship_city, province: x.ship_province, postal: x.ship_postal, country: x.ship_country },
      totalPaid: x.total_paid, tax: x.tax, shipping: x.shipping, promoCode: x.promo_code, refCode: x.ref_code,
      associateName: x.associate_name, jerseys: x.jersey_count, items: x.items,
    };
    return { ...view, supplierText: supplierText(view) };
  });
}

/** Email you the new order with the supplier list. Called after the order is saved; a failed email changes nothing. */
export async function emailWebsiteOrder(saleId: number) {
  const [o] = await listWebsiteOrders(pool, { saleId });
  if (!o) return false;
  const lines = [
    o.supplierText, '', '—',
    `Customer: ${o.customerName}${o.email ? ` <${o.email}>` : ''}`,
    `Paid: ${dollars(o.totalPaid)} (tax ${dollars(o.tax)}, shipping ${dollars(o.shipping)})`,
    o.associateName ? `Brought by: ${o.associateName}${o.promoCode ? ` (code ${o.promoCode})` : ' (referral link)'}` : 'Brought by: nobody (no code or link)',
  ];
  return sendEmail({
    subject: `${o.environment === 'sandbox' ? '[TEST] ' : ''}New website order #${o.saleId}: ${o.jerseys} jersey${o.jerseys === 1 ? '' : 's'} for ${o.customerName}`,
    text: lines.join('\n'),
  });
}
