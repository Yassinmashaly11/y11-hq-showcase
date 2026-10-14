import { Db } from '../db/pool.js';

/** Activity Log: a permanent record of who did what. */
export async function logActivity(db: Db, actorId: number | null, action: string, details: object = {}) {
  await db.query(`INSERT INTO activity_log (actor_id, action, details) VALUES ($1, $2, $3)`, [
    actorId,
    action,
    JSON.stringify(details),
  ]);
}
