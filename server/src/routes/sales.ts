import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { me, requireOwner } from '../auth.js';
import { approveSale, createSale, quoteSale, rejectSale } from '../services/sales.js';

export const salesRoutes = Router();
const id = (v: unknown) => z.coerce.number().int().positive().parse(v);

const SaleBody = z.object({
  source: z.enum(['in_hand', 'stock']),
  paymentMethod: z.enum(['etransfer', 'cash']),
  whatsapp: z.boolean().optional(),
  customerName: z.string().trim().min(1, 'Customer name is required'),
  customerEmail: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  notes: z.string().trim().max(500).optional(),
  items: z.array(z.object({
    variantId: z.number().int(),
    quantity: z.number().int().positive(),
    nameNumber: z.boolean().optional(),
    customText: z.string().trim().max(40).optional(),
    patch: z.boolean().optional(),
  })).min(1, 'Add at least one jersey'),
}).refine((b) => b.paymentMethod !== 'etransfer' || !!b.customerEmail, {
  message: 'Enter the email the e-Transfer came from', path: ['customerEmail'],
});

salesRoutes.get('/sales', async (req, res) => {
  const u = me(req);
  const status = z.enum(['pending', 'approved', 'rejected']).optional().parse(req.query.status || undefined);
  const params: unknown[] = [];
  const where: string[] = [];
  if (u.role !== 'owner') { params.push(u.id); where.push(`s.associate_id = $${params.length}`); }
  if (status) { params.push(status); where.push(`s.status = $${params.length}`); }
  const isOwner = u.role === 'owner';

  const r = await pool.query(
    `SELECT s.id, s.associate_id AS "associateId", s.channel,
            CASE WHEN s.channel = 'website' AND a.id IS NULL THEN 'Website' ELSE COALESCE(a.full_name, 'You (CEO)') END AS "soldBy",
            s.payment_method AS "paymentMethod", s.customer_name AS "customerName",
            ${isOwner ? 's.customer_email' : `CASE WHEN s.channel = 'website' THEN NULL ELSE s.customer_email END`} AS "customerEmail",
            s.status, s.created_at AS "createdAt", s.decided_at AS "decidedAt", s.reject_reason AS "rejectReason",
            s.notes, s.jersey_count AS "jerseyCount", s.squad_deal AS "squadDeal", s.revenue, s.shipping,
            s.whatsapp_discount AS "whatsappDiscount",
            ${isOwner ? 's.cost, s.profit,' : ''}
            CASE WHEN s.channel = 'website' THEN
              -- Website jerseys aren't HQ stock, so they're stored with the order instead of as sale_items.
              (SELECT json_agg(json_build_object('team', COALESCE(w.team, w.title), 'kit', CONCAT_WS(' ', w.kit, w.season),
                       'size', w.size, 'quantity', w.quantity, 'nameNumber', (w.print_name IS NOT NULL OR w.print_number IS NOT NULL),
                       'customText', NULLIF(CONCAT_WS(' ', w.print_name, w.print_number), ''), 'patch', w.patch) ORDER BY w.id)
                 FROM website_order_items w JOIN website_orders o ON o.id = w.website_order_id WHERE o.sale_id = s.id)
            ELSE
              (SELECT json_agg(json_build_object('team', p.team, 'kit', p.kit, 'size', v.size, 'quantity', i.quantity,
                       'nameNumber', i.name_number, 'customText', i.custom_text, 'patch', i.patch, 'unitPrice', i.unit_price))
                 FROM sale_items i JOIN variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
                WHERE i.sale_id = s.id)
            END AS items
       FROM sales s LEFT JOIN users a ON a.id = s.associate_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.created_at DESC LIMIT 200`,
    params,
  );
  res.json(r.rows);
});

salesRoutes.post('/sales/quote', async (req, res) => {
  const b = SaleBody.safeParse(req.body);
  const body = b.success ? b.data : { ...req.body, items: req.body.items ?? [] };
  const c = await pool.connect();
  try {
    const t = await quoteSale(c, body);
    res.json({
      revenue: t.revenue, shipping: t.shipping, total: t.revenue + t.shipping, jerseyCount: t.jerseyCount,
      squadDeal: t.squadDeal, whatsappDiscount: t.whatsappDiscount,
    });
  } finally { c.release(); }
});

salesRoutes.post('/sales', async (req, res) => {
  const b = SaleBody.parse(req.body);
  const saleId = await tx((c) => createSale(c, me(req), b));
  res.status(201).json({ id: saleId });
});

salesRoutes.post('/sales/:id/approve', requireOwner, async (req, res) => {
  await tx((c) => approveSale(c, id(req.params.id), me(req)));
  res.json({ ok: true });
});

salesRoutes.post('/sales/:id/reject', requireOwner, async (req, res) => {
  const { reason } = z.object({ reason: z.string().trim().min(1, 'Give a reason') }).parse(req.body);
  await tx((c) => rejectSale(c, id(req.params.id), me(req), reason));
  res.json({ ok: true });
});
