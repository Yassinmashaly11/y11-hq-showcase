import 'dotenv/config';
import pg from 'pg';

// NUMERIC columns come back as strings by default; turn them into numbers.
pg.types.setTypeParser(1700, (v) => parseFloat(v));
// COUNT(*) and SUM(int) are bigint (type 20); our counts are small, so numbers are safe.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

// Days, weeks and months are counted in Toronto time, so "today" means your today.
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: `-c timezone=${process.env.BUSINESS_TZ ?? 'America/Toronto'}`,
});

export type Db = pg.Pool | pg.PoolClient;

/** Run several queries as one all-or-nothing transaction. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
