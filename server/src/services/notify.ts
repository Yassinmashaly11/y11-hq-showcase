import { Db } from '../db/pool.js';

/** Send a notification to one person (shows in their bell). */
export async function notify(db: Db, userId: number, kind: string, message: string, link?: string) {
  await db.query(`INSERT INTO notifications (user_id, kind, message, link) VALUES ($1,$2,$3,$4)`, [userId, kind, message, link ?? null]);
}

/** Send to the CEO. */
export async function notifyOwner(db: Db, kind: string, message: string, link?: string) {
  await db.query(
    `INSERT INTO notifications (user_id, kind, message, link) SELECT id, $1, $2, $3 FROM users WHERE role = 'owner'`,
    [kind, message, link ?? null],
  );
}

/** Send to every active associate. */
export async function notifyTeam(db: Db, kind: string, message: string, link?: string) {
  await db.query(
    `INSERT INTO notifications (user_id, kind, message, link)
     SELECT id, $1, $2, $3 FROM users WHERE role = 'associate' AND active`,
    [kind, message, link ?? null],
  );
}
