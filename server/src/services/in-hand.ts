import pg from 'pg';
import { Actor, HttpError } from './sales.js';
import { logActivity } from './activity.js';
import { notify, notifyOwner } from './notify.js';

export type UpdateKind = 'returned' | 'lost' | 'damaged';
export interface UpdateInput { kind: UpdateKind; quantity?: number; note?: string }

/** Expense category used when a lost or damaged jersey is confirmed. */
export const LOST_JERSEY_EXPENSE = 'Lost/damaged jersey';

/** How each kind reads in messages. "lost" is stored as is, but people see "lost or stolen". */
const KIND_TEXT: Record<UpdateKind, string> = { returned: 'returned', lost: 'lost or stolen', damaged: 'damaged' };

/** "2× Brazil Home (M)" for messages. */
export const jerseyText = (qty: number, j: { team: string; kit: string; size: string }) =>
  `${qty > 1 ? `${qty}× ` : ''}${j.team} ${j.kit} (${j.size})`;

/**
 * An associate says some of their jerseys in hand were returned, lost or damaged.
 * Nothing moves yet: the jerseys are held as "Waiting for Yassin" until the CEO decides.
 */
export async function requestUpdate(c: pg.PoolClient, associateId: number, inHandId: number, input: UpdateInput) {
  const h = (await c.query(
    `SELECT h.*, p.team, p.kit, v.size, u.full_name
       FROM in_hand h JOIN variants v ON v.id = h.variant_id JOIN products p ON p.id = v.product_id
       JOIN users u ON u.id = h.associate_id
      WHERE h.id = $1 AND h.associate_id = $2 AND h.quantity > 0
        FOR UPDATE OF h`,
    [inHandId, associateId],
  )).rows[0];
  // Someone else's jersey looks exactly like one that doesn't exist.
  if (!h) throw new HttpError(404, 'Jersey not found');
  const waiting = await c.query(`SELECT 1 FROM in_hand_updates WHERE in_hand_id = $1 AND status = 'pending'`, [inHandId]);
  if (waiting.rowCount) throw new HttpError(409, 'This jersey is already waiting for Yassin');

  const qty = input.quantity ?? h.quantity;
  if (qty > h.quantity) throw new HttpError(400, `You only have ${h.quantity} of these`);

  // Jerseys already in a pending sale can't also be reported returned, lost or damaged.
  const free = (await c.query(
    `SELECT (SELECT COALESCE(SUM(quantity), 0) FROM in_hand h WHERE associate_id = $1 AND variant_id = $2
               AND NOT EXISTS (SELECT 1 FROM in_hand_updates r WHERE r.in_hand_id = h.id AND r.status = 'pending'))
          - (SELECT COALESCE(SUM(i.quantity), 0) FROM sale_items i JOIN sales s ON s.id = i.sale_id
              WHERE s.status = 'pending' AND s.associate_id = $1 AND i.variant_id = $2 AND i.from_in_hand) AS n`,
    [associateId, h.variant_id],
  )).rows[0].n as number;
  if (qty > free) {
    throw new HttpError(400, free > 0 ? `Only ${free} of these aren't in a sale waiting for approval` : 'This jersey is in a sale waiting for approval');
  }

  // Reporting only part of a batch: split those off, so the rest stay sellable as normal.
  // Copied inside SQL: JavaScript dates drop the microseconds, and the dates must match exactly to merge back.
  let rowId: number = h.id;
  if (qty < h.quantity) {
    await c.query(`UPDATE in_hand SET quantity = quantity - $2 WHERE id = $1`, [h.id, qty]);
    rowId = (await c.query(
      `INSERT INTO in_hand (associate_id, variant_id, quantity, assigned_at, due_at, overdue_notified)
       SELECT associate_id, variant_id, $2, assigned_at, due_at, overdue_notified FROM in_hand WHERE id = $1 RETURNING id`,
      [h.id, qty],
    )).rows[0].id;
  }

  const r = await c.query(
    `INSERT INTO in_hand_updates (in_hand_id, associate_id, kind, quantity, note) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [rowId, associateId, input.kind, qty, input.note || null],
  );
  const what = jerseyText(qty, h);
  await notifyOwner(c, 'jersey_update', input.kind === 'returned'
    ? `${h.full_name} says they returned ${what}. Confirm it.`
    : `${h.full_name} reported ${what} as ${KIND_TEXT[input.kind]}. Confirm it.`, '/approvals');
  await logActivity(c, associateId, 'jersey_update_requested', { updateId: r.rows[0].id, associateId, kind: input.kind, quantity: qty, jersey: what });
  return r.rows[0].id as number;
}

/**
 * The CEO confirms or declines a jersey update.
 * Confirm "returned": back into main stock. Confirm "lost"/"damaged": off their list, and its cost becomes an expense.
 * Decline: the jerseys are normal in-hand jerseys again.
 */
export async function decideUpdate(c: pg.PoolClient, actor: Actor, updateId: number, confirm: boolean) {
  const u = (await c.query(`SELECT * FROM in_hand_updates WHERE id = $1 FOR UPDATE`, [updateId])).rows[0];
  if (!u) throw new HttpError(404, 'Jersey update not found');
  if (u.status !== 'pending') throw new HttpError(409, `This update was already ${u.status}`);

  const h = (await c.query(
    `SELECT h.*, p.team, p.kit, v.size, t.cost, a.full_name
       FROM in_hand h JOIN variants v ON v.id = h.variant_id JOIN products p ON p.id = v.product_id
       JOIN product_types t ON t.id = p.type_id JOIN users a ON a.id = h.associate_id
      WHERE h.id = $1 FOR UPDATE OF h`,
    [u.in_hand_id],
  )).rows[0];
  const what = jerseyText(u.quantity, h);
  let expense: number | null = null;

  if (confirm) {
    if (h.quantity < u.quantity) throw new HttpError(409, 'Those jerseys are no longer in hand');
    await c.query(`UPDATE in_hand SET quantity = quantity - $2 WHERE id = $1`, [h.id, u.quantity]);
    if (u.kind === 'returned') {
      await c.query(`UPDATE variants SET stock = stock + $2 WHERE id = $1`, [h.variant_id, u.quantity]);
    } else {
      // It never comes back, so what you paid the supplier for it is a cost of the business.
      expense = Math.round(h.cost * u.quantity * 100) / 100;
      await c.query(
        `INSERT INTO expenses (category, description, amount, created_by) VALUES ($1,$2,$3,$4)`,
        [LOST_JERSEY_EXPENSE, `${what} ${KIND_TEXT[u.kind as UpdateKind]}, reported by ${h.full_name}${u.note ? `: ${u.note}` : ''}`, expense, actor.id],
      );
    }
  } else {
    // If these were split off a batch, put them back with the rest so the list looks like before.
    const rest = (await c.query(
      `SELECT o.id FROM in_hand o JOIN in_hand h ON h.id = $1
        WHERE o.associate_id = h.associate_id AND o.variant_id = h.variant_id
          AND o.assigned_at = h.assigned_at AND o.due_at = h.due_at AND o.id <> h.id AND o.quantity > 0
          AND NOT EXISTS (SELECT 1 FROM in_hand_updates r WHERE r.in_hand_id = o.id AND r.status = 'pending')
        LIMIT 1 FOR UPDATE OF o`,
      [h.id],
    )).rows[0];
    if (rest) {
      await c.query(`UPDATE in_hand SET quantity = quantity + $2 WHERE id = $1`, [rest.id, h.quantity]);
      await c.query(`UPDATE in_hand SET quantity = 0 WHERE id = $1`, [h.id]);
    }
  }

  await c.query(
    `UPDATE in_hand_updates SET status = $2, decided_at = now(), decided_by = $3 WHERE id = $1`,
    [updateId, confirm ? 'confirmed' : 'declined', actor.id],
  );
  await notify(c, u.associate_id, confirm ? 'jersey_update_confirmed' : 'jersey_update_declined', confirm
    ? `Yassin confirmed ${what} as ${KIND_TEXT[u.kind as UpdateKind]}. It's off your list.`
    : `Yassin declined your update for ${what}. It's back in your jerseys in hand.`, '/stock');
  await logActivity(c, actor.id, confirm ? 'jersey_update_confirmed' : 'jersey_update_declined',
    { updateId, associateId: u.associate_id, kind: u.kind, quantity: u.quantity, jersey: what, expense });
}
