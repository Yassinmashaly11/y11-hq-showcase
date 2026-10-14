import { Router } from 'express';
import { z } from 'zod';
import { pool, tx } from '../db/pool.js';
import { me, requireOwner } from '../auth.js';
import { HttpError } from '../services/sales.js';
import { getSettings } from '../services/settings.js';
import { logActivity } from '../services/activity.js';
import { decideUpdate, requestUpdate } from '../services/in-hand.js';
import { approveStockRequest, createStockRequest, declineStockRequest } from '../services/stock-requests.js';

export const inventoryRoutes = Router();
const id = (v: unknown) => z.coerce.number().int().positive().parse(v);

// Catalog: every jersey and size. Associates never see costs, and only see stock counts if allowed.
inventoryRoutes.get('/catalog', async (req, res) => {
  const u = me(req);
  const isOwner = u.role === 'owner';
  const canSeeStock = isOwner || (await pool.query(`SELECT can_see_stock FROM users WHERE id = $1`, [u.id])).rows[0]?.can_see_stock;

  const types = (await pool.query(`SELECT * FROM product_types ORDER BY id`)).rows
    .map((t) => (isOwner ? t : { id: t.id, code: t.code, name: t.name, price: t.price }));
  const products = (await pool.query(
    `SELECT p.id, p.team, p.kit, p.season, p.type_id AS "typeId", p.active,
            COALESCE(json_agg(json_build_object('id', v.id, 'size', v.size, 'stock', v.stock)
              ORDER BY array_position(ARRAY['XS','S','M','L','XL','2XL','3XL'], v.size)) FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
       FROM products p LEFT JOIN variants v ON v.product_id = p.id
      ${isOwner ? '' : 'WHERE p.active'}
      GROUP BY p.id ORDER BY p.team, p.kit`,
  )).rows.map((p) => (canSeeStock ? p : { ...p, variants: p.variants.map((v: any) => ({ ...v, stock: null })) }));

  res.json({ types, products, canSeeStock });
});

const NewProduct = z.object({
  team: z.string().trim().min(1),
  kit: z.string().trim().min(1),
  season: z.string().trim().optional(),
  typeId: z.number().int(),
  sizes: z.array(z.object({ size: z.string().trim().toUpperCase(), stock: z.number().int().min(0) })).min(1),
});

inventoryRoutes.post('/products', requireOwner, async (req, res) => {
  const b = NewProduct.parse(req.body);
  const productId = await tx(async (c) => {
    const p = await c.query(
      `INSERT INTO products (team, kit, season, type_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.team, b.kit, b.season ?? null, b.typeId],
    );
    for (const s of b.sizes) {
      await c.query(`INSERT INTO variants (product_id, size, stock) VALUES ($1,$2,$3)`, [p.rows[0].id, s.size, s.stock]);
    }
    await logActivity(c, me(req).id, 'product_added', { productId: p.rows[0].id, team: b.team, kit: b.kit });
    return p.rows[0].id;
  });
  res.status(201).json({ id: productId });
});

inventoryRoutes.patch('/products/:id', requireOwner, async (req, res) => {
  const b = z.object({ active: z.boolean() }).parse(req.body);
  await pool.query(`UPDATE products SET active = $2 WHERE id = $1`, [id(req.params.id), b.active]);
  res.json({ ok: true });
});

inventoryRoutes.post('/products/:id/variants', requireOwner, async (req, res) => {
  const b = z.object({ size: z.string().trim().toUpperCase(), stock: z.number().int().min(0) }).parse(req.body);
  await pool.query(
    `INSERT INTO variants (product_id, size, stock) VALUES ($1,$2,$3)
     ON CONFLICT (product_id, size) DO UPDATE SET stock = variants.stock + EXCLUDED.stock`,
    [id(req.params.id), b.size, b.stock],
  );
  res.status(201).json({ ok: true });
});

// Set a size's stock to an exact number (e.g. after counting, or a new shipment arrives).
inventoryRoutes.patch('/variants/:id', requireOwner, async (req, res) => {
  const b = z.object({ stock: z.number().int().min(0) }).parse(req.body);
  const r = await pool.query(`UPDATE variants SET stock = $2 WHERE id = $1 RETURNING stock`, [id(req.params.id), b.stock]);
  if (!r.rowCount) throw new HttpError(404, 'Size not found');
  await logActivity(pool, me(req).id, 'stock_set', { variantId: id(req.params.id), stock: b.stock });
  res.json(r.rows[0]);
});

// ----- In-hand stock: jerseys an associate is carrying -----

inventoryRoutes.get('/in-hand', async (req, res) => {
  const u = me(req);
  // A jersey with an update waiting for the CEO is never shown as overdue.
  const r = await pool.query(
    `SELECT h.id, h.associate_id AS "associateId", a.full_name AS "associateName", h.variant_id AS "variantId",
            h.quantity, h.assigned_at AS "assignedAt", h.due_at AS "dueAt", h.due_at < now() AND r.id IS NULL AS overdue,
            p.team, p.kit, v.size,
            CASE WHEN r.id IS NULL THEN NULL
                 ELSE json_build_object('id', r.id, 'kind', r.kind, 'note', r.note, 'createdAt', r.created_at) END AS "pendingUpdate"
       FROM in_hand h JOIN users a ON a.id = h.associate_id JOIN variants v ON v.id = h.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN in_hand_updates r ON r.in_hand_id = h.id AND r.status = 'pending'
      WHERE h.quantity > 0 ${u.role === 'owner' ? '' : 'AND h.associate_id = $1'}
      ORDER BY a.full_name, h.due_at`,
    u.role === 'owner' ? [] : [u.id],
  );

  // How many of each row's jerseys are in a sale waiting for approval ("Sale waiting for Yassin").
  // Sales are logged per jersey and size, not per row, so share them out oldest row first: the same order approval takes them.
  const pending = await pool.query(
    `SELECT s.associate_id, i.variant_id, SUM(i.quantity) AS n FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE s.status = 'pending' AND i.from_in_hand ${u.role === 'owner' ? '' : 'AND s.associate_id = $1'}
      GROUP BY s.associate_id, i.variant_id`,
    u.role === 'owner' ? [] : [u.id],
  );
  const left = new Map<string, number>(pending.rows.map((p) => [`${p.associate_id}:${p.variant_id}`, p.n]));
  const rows = r.rows.map((h) => ({ ...h, inPendingSale: 0 }));
  const oldestFirst = [...rows].sort((a, b) => +a.assignedAt - +b.assignedAt || a.id - b.id);
  for (const h of oldestFirst.filter((x) => !x.pendingUpdate)) {
    const key = `${h.associateId}:${h.variantId}`;
    h.inPendingSale = Math.min(h.quantity, left.get(key) ?? 0);
    left.set(key, (left.get(key) ?? 0) - h.inPendingSale);
  }
  res.json(rows);
});

// The associate's own tally (Given · Sold · Left) and what they sold in the last 30 days.
// Given isn't stored: it's everything that left their hands plus what they still hold, so it always adds up.
inventoryRoutes.get('/in-hand/mine', async (req, res) => {
  const uid = me(req).id;
  const [totals, sold] = await Promise.all([
    pool.query(
      `SELECT (SELECT COALESCE(SUM(quantity), 0) FROM in_hand WHERE associate_id = $1) AS "jerseysLeft",
              (SELECT COALESCE(SUM(i.quantity), 0) FROM sale_items i JOIN sales s ON s.id = i.sale_id
                WHERE s.associate_id = $1 AND s.status = 'approved' AND i.from_in_hand) AS sold,
              (SELECT COALESCE(SUM(quantity), 0) FROM in_hand_updates
                WHERE associate_id = $1 AND status = 'confirmed' AND kind = 'returned') AS returned,
              (SELECT COALESCE(SUM(quantity), 0) FROM in_hand_updates
                WHERE associate_id = $1 AND status = 'confirmed' AND kind <> 'returned') AS "lostOrDamaged"`,
      [uid],
    ),
    pool.query(
      `SELECT i.id, s.id AS "saleId", p.team, p.kit, v.size, i.quantity, s.decided_at AS "soldAt"
         FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
        WHERE s.associate_id = $1 AND s.status = 'approved' AND i.from_in_hand AND s.decided_at >= now() - interval '30 days'
        ORDER BY s.decided_at DESC`,
      [uid],
    ),
  ]);
  const t = totals.rows[0];
  res.json({
    given: t.jerseysLeft + t.sold + t.returned + t.lostOrDamaged,
    sold: t.sold, returned: t.returned, lostOrDamaged: t.lostOrDamaged, left: t.jerseysLeft,
    recentlySold: sold.rows,
  });
});

const Assign = z.object({ associateId: z.number().int(), variantId: z.number().int(), quantity: z.number().int().positive() });

inventoryRoutes.post('/in-hand', requireOwner, async (req, res) => {
  const b = Assign.parse(req.body);
  const s = await getSettings(pool);
  await tx(async (c) => {
    const a = await c.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'associate' AND active`, [b.associateId]);
    if (!a.rowCount) throw new HttpError(400, 'That associate is not active');
    const r = await c.query(`UPDATE variants SET stock = stock - $2 WHERE id = $1 AND stock >= $2`, [b.variantId, b.quantity]);
    if (!r.rowCount) throw new HttpError(400, 'Not enough in main stock');
    await c.query(
      `INSERT INTO in_hand (associate_id, variant_id, quantity, due_at) VALUES ($1,$2,$3, now() + make_interval(days => $4))`,
      [b.associateId, b.variantId, b.quantity, s.inHandDays],
    );
    await logActivity(c, me(req).id, 'in_hand_assigned', b);
  });
  res.status(201).json({ ok: true });
});

inventoryRoutes.post('/in-hand/:id/return', requireOwner, async (req, res) => {
  const hid = id(req.params.id);
  const b = z.object({ quantity: z.number().int().positive().optional() }).parse(req.body ?? {});
  await tx(async (c) => {
    const h = (await c.query(`SELECT * FROM in_hand WHERE id = $1 FOR UPDATE`, [hid])).rows[0];
    if (!h) throw new HttpError(404, 'Not found');
    const waiting = await c.query(`SELECT 1 FROM in_hand_updates WHERE in_hand_id = $1 AND status = 'pending'`, [hid]);
    if (waiting.rowCount) throw new HttpError(409, 'This jersey has an update waiting in Pending Approvals');
    const qty = b.quantity ?? h.quantity;
    if (qty > h.quantity) throw new HttpError(400, `They only have ${h.quantity}`);
    await c.query(`UPDATE in_hand SET quantity = quantity - $2 WHERE id = $1`, [hid, qty]);
    await c.query(`UPDATE variants SET stock = stock + $2 WHERE id = $1`, [h.variant_id, qty]);
    // Recorded like a confirmed "I returned it", so the associate's Given · Sold · Left still adds up.
    await c.query(
      `INSERT INTO in_hand_updates (in_hand_id, associate_id, kind, quantity, note, status, decided_at, decided_by)
       VALUES ($1, $2, 'returned', $3, 'Marked returned in Inventory', 'confirmed', now(), $4)`,
      [hid, h.associate_id, qty, me(req).id],
    );
    await logActivity(c, me(req).id, 'in_hand_returned', { inHandId: hid, quantity: qty, associateId: h.associate_id });
  });
  res.json({ ok: true });
});

// ----- Jersey updates: associates report in-hand jerseys returned, lost or damaged; the CEO confirms -----

const UpdateBody = z.object({
  kind: z.enum(['returned', 'lost', 'damaged']),
  quantity: z.number().int().positive().optional(),
  note: z.string().trim().max(300).optional(),
});

// Associates only: requestUpdate only finds jerseys that belong to the person asking.
inventoryRoutes.post('/in-hand/:id/updates', async (req, res) => {
  const b = UpdateBody.parse(req.body);
  const updateId = await tx((c) => requestUpdate(c, me(req).id, id(req.params.id), b));
  res.status(201).json({ id: updateId });
});

inventoryRoutes.get('/jersey-updates', requireOwner, async (req, res) => {
  const status = z.enum(['pending', 'confirmed', 'declined']).catch('pending').parse(req.query.status);
  const r = await pool.query(
    `SELECT r.id, r.kind, r.quantity, r.note, r.status, r.created_at AS "createdAt", r.associate_id AS "associateId",
            a.full_name AS "associateName", p.team, p.kit, v.size, h.due_at AS "dueAt", t.cost * r.quantity AS cost
       FROM in_hand_updates r JOIN in_hand h ON h.id = r.in_hand_id JOIN users a ON a.id = r.associate_id
       JOIN variants v ON v.id = h.variant_id JOIN products p ON p.id = v.product_id JOIN product_types t ON t.id = p.type_id
      WHERE r.status = $1 ORDER BY r.created_at LIMIT 200`,
    [status],
  );
  res.json(r.rows);
});

inventoryRoutes.post('/jersey-updates/:id/confirm', requireOwner, async (req, res) => {
  await tx((c) => decideUpdate(c, me(req), id(req.params.id), true));
  res.json({ ok: true });
});

inventoryRoutes.post('/jersey-updates/:id/decline', requireOwner, async (req, res) => {
  await tx((c) => decideUpdate(c, me(req), id(req.params.id), false));
  res.json({ ok: true });
});

// ----- Stock requests: associates ask for more jerseys; the CEO approves & hands them over -----

const StockRequestBody = z.object({
  items: z.array(z.object({ variantId: z.number().int(), quantity: z.number().int().positive() })).min(1, 'Pick at least one jersey'),
  note: z.string().trim().max(300).optional(),
});

inventoryRoutes.post('/stock-requests', async (req, res) => {
  const u = me(req);
  if (u.role !== 'associate') throw new HttpError(403, 'Only associates request jerseys');
  const b = StockRequestBody.parse(req.body);
  const requestId = await tx((c) => createStockRequest(c, u.id, b.items, b.note));
  res.status(201).json({ id: requestId });
});

// CEO: every request with a status (pending by default). Associates: their own recent requests.
inventoryRoutes.get('/stock-requests', async (req, res) => {
  const u = me(req);
  const isOwner = u.role === 'owner';
  const status = z.enum(['pending', 'approved', 'declined']).catch('pending').parse(req.query.status);
  const r = await pool.query(
    `SELECT r.id, r.associate_id AS "associateId", a.full_name AS "associateName", r.note, r.status,
            r.created_at AS "createdAt", r.decided_at AS "decidedAt",
            json_agg(json_build_object('id', i.id, 'variantId', i.variant_id, 'team', p.team, 'kit', p.kit, 'size', v.size,
                     'quantity', i.quantity, 'approved', i.approved ${isOwner ? ", 'stock', v.stock" : ''}) ORDER BY i.id) AS items
       FROM stock_requests r JOIN users a ON a.id = r.associate_id JOIN stock_request_items i ON i.request_id = r.id
       JOIN variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
      WHERE ${isOwner ? 'r.status = $1' : 'r.associate_id = $1'}
      GROUP BY r.id, a.full_name
      ORDER BY r.created_at ${isOwner ? '' : 'DESC'} LIMIT ${isOwner ? 200 : 20}`,
    [isOwner ? status : u.id],
  );
  res.json(r.rows);
});

inventoryRoutes.post('/stock-requests/:id/approve', requireOwner, async (req, res) => {
  const b = z.object({
    items: z.array(z.object({ itemId: z.number().int(), quantity: z.number().int().min(0) })).optional(),
  }).parse(req.body ?? {});
  await tx((c) => approveStockRequest(c, me(req), id(req.params.id), b.items));
  res.json({ ok: true });
});

inventoryRoutes.post('/stock-requests/:id/decline', requireOwner, async (req, res) => {
  await tx((c) => declineStockRequest(c, me(req), id(req.params.id)));
  res.json({ ok: true });
});
