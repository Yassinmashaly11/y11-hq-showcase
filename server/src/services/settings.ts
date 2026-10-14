import { Db } from '../db/pool.js';
import { BusinessSettings, mergeSettings } from '../domain/settings.js';

export async function getSettings(db: Db): Promise<BusinessSettings> {
  const r = await db.query(`SELECT value FROM settings WHERE key = 'business'`);
  return mergeSettings(r.rows[0]?.value);
}

export async function saveSettings(db: Db, s: BusinessSettings) {
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('business', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(s)],
  );
}
