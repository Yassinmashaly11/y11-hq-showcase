import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { pool } from './pool.js';

export async function migrate() {
  const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

// Run directly (npm run db:...), not when imported. pathToFileURL handles spaces in folder names.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrate()
    .then(() => console.log('Database schema is up to date.'))
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => pool.end());
}
