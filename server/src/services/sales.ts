import pg from 'pg';
import { priceSale, PricingLine } from '../domain/pricing.js';
import { applySale } from '../domain/levels.js';
import { getSettings } from './settings.js';
import { loadState, saveState, recordEvents, recordEarnings } from './levels.js';
import { logActivity } from './activity.js';
import { notify, notifyOwner } from './notify.js';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface SaleItemInput {
  variantId: number;
  quantity: number;
  nameNumber?: boolean;
  customText?: string;
  patch?: boolean;
}

export interface NewSaleInput {
  source: 'in_hand' | 'stock';        // in_hand = jerseys the associate is holding
  paymentMethod: 'etransfer' | 'cash';
  whatsapp?: boolean;                  // the customer ordered on WhatsApp: WhatsApp discount applies
  customerName: string;
  customerEmail?: string;
  notes?: string;
  items: SaleItemInput[];
}

export interface Actor { id: number; role: 'owner' | 'associate' }

async function loadLines(c: pg.PoolClient, items: SaleItemInput[]) {
  const ids = items.map((i) => i.variantId);
  const r = await c.query(
    `SELECT v.id, v.size, v.stock, t.price, t.cost, p.team, p.kit
       FROM variants v JOIN products p ON p.id = v.product_id JOIN product_types t ON t.id = p.type_id
      WHERE v.id = ANY($1)`,
    [ids],
  );
  const byId = new Map(r.rows.map((row) => [row.id, row]));
  return items.map((i) => {
    const v = byId.get(i.variantId);
    if (!v) throw new HttpError(400, `Jersey size ${i.variantId} does not exist`);
    const line: PricingLine = {
      size: v.size, quantity: i.quantity, typePrice: v.price, typeCost: v.cost,
      nameNumber: !!i.nameNumber, patch: !!i.patch,
    };
    return { input: i, variant: v, line };
  });
}

// Jerseys with an update waiting for the CEO (returned / lost / damaged) can't be sold.
async function inHandCount(c: pg.PoolClient, associateId: number, variantId: number) {
  const r = await c.query(
    `SELECT COALESCE(SUM(quantity), 0) AS n FROM in_hand h WHERE associate_id = $1 AND variant_id = $2
        AND NOT EXISTS (SELECT 1 FROM in_hand_updates r WHERE r.in_hand_id = h.id AND r.status = 'pending')`,
    [associateId, variantId],
  );
  return r.rows[0].n as number;
}

/** Price a sale without saving it (used by the Add Sale form to show the total). */
export async function quoteSale(c: pg.PoolClient, input: NewSaleInput) {
  const s = await getSettings(c);
  const loaded = await loadLines(c, input.items);
  return priceSale(loaded.map((l) => l.line), s, { chargeShipping: input.source === 'stock', whatsapp: !!input.whatsapp });
}

/**
 * Associates' sales start as "pending" until the CEO approves them.
 * The CEO's own sales are approved straight away.
 */
export async function createSale(c: pg.PoolClient, actor: Actor, input: NewSaleInput, now = new Date()) {
  if (input.items.length === 0) throw new HttpError(400, 'Add at least one jersey');
  if (actor.role === 'owner' && input.source === 'in_hand') throw new HttpError(400, 'The CEO sells from main stock');

  const s = await getSettings(c);
  const loaded = await loadLines(c, input.items);

  // Check stock now so associates find out immediately if something isn't available.
  // Jerseys already in another pending sale are held back, so the same jersey can't be sold twice.
  for (const l of loaded) {
    const pending = (await c.query(
      `SELECT COALESCE(SUM(i.quantity), 0) AS n FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE s.status = 'pending' AND i.variant_id = $1 AND i.from_in_hand = $2 ${input.source === 'in_hand' ? 'AND s.associate_id = $3' : ''}`,
      input.source === 'in_hand' ? [l.variant.id, true, actor.id] : [l.variant.id, false],
    )).rows[0].n as number;
    const available = (input.source === 'in_hand'
      ? await inHandCount(c, actor.id, l.variant.id)
      : l.variant.stock) - pending;
    if (available < l.input.quantity) {
      throw new HttpError(400, `Not enough ${l.variant.team} ${l.variant.kit} (${l.variant.size}): ${available} available`);
    }
  }

  const totals = priceSale(loaded.map((l) => l.line), s, { chargeShipping: input.source === 'stock', whatsapp: !!input.whatsapp });
  const isOwner = actor.role === 'owner';
  const channel = isOwner ? 'owner' : input.source === 'in_hand' ? 'in_hand' : 'etransfer';

  const sale = await c.query(
    `INSERT INTO sales (associate_id, channel, payment_method, customer_name, customer_email, created_by, created_at,
                        notes, jersey_count, squad_deal, revenue, cost, profit, shipping, whatsapp_discount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [isOwner ? null : actor.id, channel, input.paymentMethod, input.customerName, input.customerEmail ?? null,
     actor.id, now, input.notes ?? null, totals.jerseyCount, totals.squadDeal, totals.revenue, totals.cost,
     totals.profit, totals.shipping, totals.whatsappDiscount],
  );
  const saleId: number = sale.rows[0].id;

  for (const [i, l] of loaded.entries()) {
    const p = totals.lines[i];
    await c.query(
      `INSERT INTO sale_items (sale_id, variant_id, quantity, from_in_hand, name_number, custom_text, patch, unit_price, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [saleId, l.variant.id, l.input.quantity, input.source === 'in_hand', p.nameNumber, l.input.customText ?? null,
       p.patch, p.unitPrice, p.unitCost],
    );
  }

  await logActivity(c, actor.id, 'sale_created', { saleId, total: totals.revenue + totals.shipping });
  if (isOwner) {
    await approveSale(c, saleId, actor, now);
  } else {
    const name = (await c.query(`SELECT full_name FROM users WHERE id = $1`, [actor.id])).rows[0].full_name;
    await notifyOwner(c, 'sale_pending', `${name} logged a $${totals.revenue + totals.shipping} sale to ${input.customerName}. Approve it.`, '/approvals');
  }
  return saleId;
}

/** Take one jersey size out of an associate's in-hand stock, oldest assignment first, skipping any waiting for the CEO. */
async function takeFromInHand(c: pg.PoolClient, associateId: number, variantId: number, qty: number) {
  const rows = (await c.query(
    `SELECT id, quantity FROM in_hand h WHERE associate_id = $1 AND variant_id = $2 AND quantity > 0
        AND NOT EXISTS (SELECT 1 FROM in_hand_updates r WHERE r.in_hand_id = h.id AND r.status = 'pending')
      ORDER BY assigned_at, id FOR UPDATE`,
    [associateId, variantId],
  )).rows;
  let left = qty;
  for (const r of rows) {
    if (left === 0) break;
    const take = Math.min(left, r.quantity);
    await c.query(`UPDATE in_hand SET quantity = quantity - $2 WHERE id = $1`, [r.id, take]);
    left -= take;
  }
  if (left > 0) throw new HttpError(409, 'The associate no longer has those jerseys in hand');
}

/**
 * Approving a sale is where everything happens: stock, commission, levels, cash owed.
 * `automatic`: approved by HQ itself (website orders, already paid by card), so the Activity Log
 * shows no person and the caller sends its own notifications.
 */
export async function approveSale(c: pg.PoolClient, saleId: number, actor: Actor, now = new Date(), opts: { automatic?: boolean } = {}) {
  const sale = (await c.query(`SELECT * FROM sales WHERE id = $1 FOR UPDATE`, [saleId])).rows[0];
  if (!sale) throw new HttpError(404, 'Sale not found');
  if (sale.status !== 'pending') throw new HttpError(409, `This sale is already ${sale.status}`);

  const items = (await c.query(`SELECT * FROM sale_items WHERE sale_id = $1`, [saleId])).rows;
  for (const it of items) {
    if (it.from_in_hand) {
      await takeFromInHand(c, sale.associate_id, it.variant_id, it.quantity);
    } else {
      const r = await c.query(
        `UPDATE variants SET stock = stock - $2 WHERE id = $1 AND stock >= $2 RETURNING stock`,
        [it.variant_id, it.quantity],
      );
      if (r.rowCount === 0) throw new HttpError(409, 'Not enough stock left to approve this sale');
    }
  }

  await c.query(`UPDATE sales SET status = 'approved', decided_at = $2 WHERE id = $1`, [saleId, now]);

  if (sale.associate_id) {
    const s = await getSettings(c);
    const before = await loadState(c, sale.associate_id);
    const { state, earnings, events } = applySale(before, sale.jersey_count, now, s);
    await saveState(c, sale.associate_id, state);
    await recordEarnings(c, sale.associate_id, saleId, earnings, now);
    await recordEvents(c, sale.associate_id, events, now);

    if (sale.payment_method === 'cash') {
      await c.query(
        `INSERT INTO cash_ledger (associate_id, sale_id, amount, note, created_at) VALUES ($1,$2,$3,$4,$5)`,
        [sale.associate_id, saleId, sale.revenue + sale.shipping, `Cash from ${sale.customer_name}`, now],
      );
    }
  }
  // Low-stock alerts for anything this sale took down to the limit
  const s2 = await getSettings(c);
  const low = await c.query(
    `SELECT p.team, p.kit, v.size, v.stock FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ANY($1) AND v.stock <= $2`,
    [items.filter((i) => !i.from_in_hand).map((i) => i.variant_id), s2.lowStockAt],
  );
  for (const v of low.rows) {
    await notifyOwner(c, 'low_stock', `Low stock: ${v.team} ${v.kit} (${v.size}) has ${v.stock} left.`, '/inventory');
  }
  if (sale.associate_id && !opts.automatic) {
    await notify(c, sale.associate_id, 'sale_approved', `Your sale to ${sale.customer_name} was approved.`, '/sales');
  }
  await logActivity(c, opts.automatic ? null : actor.id, 'sale_approved', { saleId });
}

export async function rejectSale(c: pg.PoolClient, saleId: number, actor: Actor, reason: string, now = new Date()) {
  const r = await c.query(
    `UPDATE sales SET status = 'rejected', decided_at = $2, reject_reason = $3 WHERE id = $1 AND status = 'pending'`,
    [saleId, now, reason],
  );
  if (r.rowCount === 0) throw new HttpError(409, 'Only pending sales can be rejected');
  const sale = (await c.query(`SELECT associate_id, customer_name FROM sales WHERE id = $1`, [saleId])).rows[0];
  if (sale.associate_id) {
    await notify(c, sale.associate_id, 'sale_rejected', `Your sale to ${sale.customer_name} was rejected: ${reason}`, '/sales');
  }
  await logActivity(c, actor.id, 'sale_rejected', { saleId, reason });
}
