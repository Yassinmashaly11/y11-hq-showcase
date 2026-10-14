import { Router, Request, Response, NextFunction } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { HttpError } from '../services/sales.js';
import { emailWebsiteOrder, recordWebsiteOrder } from '../services/website-orders.js';
import { notifyOwner } from '../services/notify.js';

/**
 * The Y11 website (y11jerseys.com, built with Lovable) talks to HQ through these routes,
 * from its backend only. Every request carries the shared key: `Authorization: Bearer <WEBSITE_API_KEY>`.
 * Website orders are made to order, so nothing here reads or changes stock.
 */
export const websiteRoutes = Router();

function requireWebsiteKey(req: Request, _res: Response, next: NextFunction) {
  const expected = process.env.WEBSITE_API_KEY;
  if (!expected) throw new HttpError(503, 'The website connection is not set up yet (WEBSITE_API_KEY)');
  const given = req.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  // Compare fixed-length hashes in constant time, so response timing can't reveal how much of the key matched.
  const hash = (s: string) => createHash('sha256').update(s).digest();
  if (!timingSafeEqual(hash(given), hash(expected))) throw new HttpError(401, 'Wrong website key');
  next();
}
websiteRoutes.use(requireWebsiteKey);

// Is this promo code real and in use? (Codes are tracking only: they don't change the price.)
websiteRoutes.get('/promo-codes/:code', async (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const r = await pool.query(
    `SELECT c.code FROM promo_codes c JOIN users a ON a.id = c.associate_id WHERE c.code = $1 AND c.active AND a.active`,
    [code],
  );
  res.json(r.rowCount ? { valid: true, code: r.rows[0].code } : { valid: false });
});

// Is this referral link (y11jerseys.com/?ref=<code>) real, for an associate still on the team?
websiteRoutes.get('/referrals/:code', async (req, res) => {
  const code = String(req.params.code).trim().toLowerCase();
  const r = await pool.query(`SELECT referral_code FROM users WHERE referral_code = $1 AND role = 'associate' AND active`, [code]);
  res.json(r.rowCount ? { valid: true, code: r.rows[0].referral_code } : { valid: false });
});

// Lenient on purpose: a paid order should never be lost because of a missing phone number.
const text = (max: number) => z.string().trim().max(max).optional();
const Order = z.object({
  stripeSessionId: z.string().trim().min(5).max(255),
  environment: z.enum(['live', 'sandbox']),
  customer: z.object({ name: text(120), email: text(200), phone: text(40) }).default({}),
  shipTo: z.object({
    name: text(120), line1: text(200), line2: text(200), city: text(100), province: text(60), postal: text(20), country: text(60),
  }).default({}),
  totalPaid: z.number().min(0),
  tax: z.number().min(0).default(0),
  shipping: z.number().min(0).default(0),
  promoCode: text(20),
  ref: text(20),
  items: z.array(z.object({
    productId: text(20), title: z.string().trim().min(1).max(140),
    team: text(80), kit: text(60), season: text(20), version: text(60),
    size: z.string().trim().min(1).max(8), quantity: z.number().int().min(1).max(50),
    kind: z.enum(['short', 'long', 'retro_short', 'retro_long', 'messi_farewell']),
    name: text(20), number: text(3), patch: z.boolean().optional(),
  })).min(1).max(30),
}).refine((o) => o.totalPaid + 0.005 >= o.tax + o.shipping, 'Tax and shipping are more than the total paid');

// A paid website order, sent by the shop's payment webhook after Stripe confirms the payment.
websiteRoutes.post('/orders', async (req, res) => {
  const o = Order.parse(req.body);
  // Stripe test-mode orders only count while you're testing (WEBSITE_TEST_ORDERS=true on Railway).
  if (o.environment === 'sandbox' && process.env.WEBSITE_TEST_ORDERS !== 'true') {
    return res.json({ ignored: 'Stripe test-mode order: WEBSITE_TEST_ORDERS is off' });
  }
  const result = await tx((c) => recordWebsiteOrder(c, o));
  // The order is saved either way; a failed email rings your bell with Resend's reason.
  if (!result.duplicate) {
    emailWebsiteOrder(result.saleId).catch(async (e) => {
      console.error('Order email failed:', e);
      await notifyOwner(pool, 'email_failed', `Couldn't email website order #${result.saleId}: ${String(e?.message ?? e).slice(0, 160)}`, '/settings')
        .catch(() => {});
    });
  }
  res.status(result.duplicate ? 200 : 201).json(result);
});

// Anything else under /api/website is unknown (rather than falling through to the login-protected routes).
websiteRoutes.use((_req, res) => { res.status(404).json({ error: 'Not found' }); });
