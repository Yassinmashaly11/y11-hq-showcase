import pg from 'pg';
import { Actor, HttpError } from './sales.js';
import { getSettings } from './settings.js';
import { logActivity } from './activity.js';
import { notify, notifyOwner } from './notify.js';
import { jerseyText } from './in-hand.js';

export interface RequestedItem { variantId: number; quantity: number }

const listText = (items: { quantity: number; team: string; kit: string; size: string }[]) =>
  items.map((i) => jerseyText(i.quantity, i)).join(', ');

/** An associate asks for more jerseys to carry. Nothing moves until the CEO approves. */
export async function createStockRequest(c: pg.PoolClient, associateId: number, items: RequestedItem[], note?: string) {
  if (new Set(items.map((i) => i.variantId)).size !== items.length) throw new HttpError(400, 'List each jersey and size only once');
  const user = (await c.query(`SELECT full_name, can_see_stock FROM users WHERE id = $1`, [associateId])).rows[0];
  const variants = new Map((await c.query(
    `SELECT v.id, v.stock, v.size, p.team, p.kit FROM variants v JOIN products p ON p.id = v.product_id
      WHERE v.id = ANY($1) AND p.active`,
    [items.map((i) => i.variantId)],
  )).rows.map((v) => [v.id, v]));

  const lines = items.map((i) => {
    const v = variants.get(i.variantId);
    if (!v) throw new HttpError(400, 'That jersey is not available');
    if (i.quantity > v.stock) {
      // Only say how many are left to someone allowed to see stock counts.
      throw new HttpError(400, user.can_see_stock
        ? `Only ${v.stock} ${v.team} ${v.kit} (${v.size}) in main stock`
        : `Not enough ${v.team} ${v.kit} (${v.size}) in main stock`);
    }
    return { ...v, quantity: i.quantity };
  });

  const requestId: number = (await c.query(
    `INSERT INTO stock_requests (associate_id, note) VALUES ($1,$2) RETURNING id`, [associateId, note || null],
  )).rows[0].id;
  for (const l of lines) {
    await c.query(`INSERT INTO stock_request_items (request_id, variant_id, quantity) VALUES ($1,$2,$3)`, [requestId, l.id, l.quantity]);
  }
  const what = listText(lines);
  await notifyOwner(c, 'stock_request', `${user.full_name} asked for ${what}. Approve it.`, '/approvals');
  await logActivity(c, associateId, 'stock_request_made', { requestId, associateId, jerseys: what });
  return requestId;
}

async function lockPending(c: pg.PoolClient, requestId: number) {
  const r = (await c.query(`SELECT * FROM stock_requests WHERE id = $1 FOR UPDATE`, [requestId])).rows[0];
  if (!r) throw new HttpError(404, 'Stock request not found');
  if (r.status !== 'pending') throw new HttpError(409, `This request was already ${r.status}`);
  return r;
}

const requestItems = async (c: pg.PoolClient, requestId: number) => (await c.query(
  `SELECT i.id, i.variant_id, i.quantity, v.size, p.team, p.kit FROM stock_request_items i
     JOIN variants v ON v.id = i.variant_id JOIN products p ON p.id = v.product_id
    WHERE i.request_id = $1 ORDER BY i.id`,
  [requestId],
)).rows;

/**
 * The CEO approves, optionally lowering amounts (itemId → quantity). Each jersey is handed over exactly
 * like giving jerseys out from Inventory: out of main stock, into their jerseys in hand, due back in 30 days.
 */
export async function approveStockRequest(c: pg.PoolClient, actor: Actor, requestId: number, amounts: { itemId: number; quantity: number }[] = []) {
  const req = await lockPending(c, requestId);
  const active = await c.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'associate' AND active`, [req.associate_id]);
  if (!active.rowCount) throw new HttpError(400, 'That associate is not active');

  const items = await requestItems(c, requestId);
  const lowered = new Map(amounts.map((a) => [a.itemId, a.quantity]));
  if ([...lowered.keys()].some((id) => !items.some((i) => i.id === id))) throw new HttpError(400, 'That jersey is not in this request');

  const s = await getSettings(c);
  const given: typeof items = [];
  for (const it of items) {
    const qty = lowered.get(it.id) ?? it.quantity;
    if (qty > it.quantity) throw new HttpError(400, `You can lower amounts, not raise them: they asked for ${jerseyText(it.quantity, it)}`);
    await c.query(`UPDATE stock_request_items SET approved = $2 WHERE id = $1`, [it.id, qty]);
    if (qty === 0) continue;
    const r = await c.query(`UPDATE variants SET stock = stock - $2 WHERE id = $1 AND stock >= $2`, [it.variant_id, qty]);
    if (!r.rowCount) throw new HttpError(400, `Not enough ${it.team} ${it.kit} (${it.size}) in main stock. Lower the amount.`);
    await c.query(
      `INSERT INTO in_hand (associate_id, variant_id, quantity, due_at) VALUES ($1,$2,$3, now() + make_interval(days => $4))`,
      [req.associate_id, it.variant_id, qty, s.inHandDays],
    );
    given.push({ ...it, quantity: qty });
  }
  if (!given.length) throw new HttpError(400, 'Hand over at least one jersey, or decline the request');

  await c.query(`UPDATE stock_requests SET status = 'approved', decided_at = now(), decided_by = $2 WHERE id = $1`, [requestId, actor.id]);
  const what = listText(given);
  await notify(c, req.associate_id, 'stock_request_approved', `Yassin approved your request. ${what} added to your jerseys in hand.`, '/stock');
  await logActivity(c, actor.id, 'stock_request_approved', { requestId, associateId: req.associate_id, jerseys: what });
}

export async function declineStockRequest(c: pg.PoolClient, actor: Actor, requestId: number) {
  const req = await lockPending(c, requestId);
  await c.query(`UPDATE stock_requests SET status = 'declined', decided_at = now(), decided_by = $2 WHERE id = $1`, [requestId, actor.id]);
  const what = listText(await requestItems(c, requestId));
  await notify(c, req.associate_id, 'stock_request_declined', `Yassin declined your request for ${what}.`, '/stock');
  await logActivity(c, actor.id, 'stock_request_declined', { requestId, associateId: req.associate_id, jerseys: what });
}
