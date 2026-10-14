import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pool } from './db/pool.js';
import { runRequestedReset, seedAll } from './db/seed.js';

// The one-time RESET_DATABASE wipe used on Railway (the database never has to be made public).
const count = async (sql: string) => (await pool.query(sql)).rows[0].n as number;

beforeAll(async () => {
  process.env.OWNER_PASSWORD = 'reset-test-pass';
  delete process.env.SEED_DEMO_DATA;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await seedAll({ reset: true });
  await pool.query(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('yusuf', 'x', 'Yusuf Ahmed', 'associate')`);
});
afterEach(() => { delete process.env.RESET_DATABASE; });
afterAll(() => pool.end());

describe('RESET_DATABASE', () => {
  it('does nothing without the variable, or with a value that doesn\'t start with delete-everything-', async () => {
    expect(await runRequestedReset()).toBe(false);
    process.env.RESET_DATABASE = 'yes';
    expect(await runRequestedReset()).toBe(false);
    expect(await count(`SELECT COUNT(*) n FROM users WHERE role = 'associate'`)).toBe(1);
  });

  it('wipes once and sets up only the CEO login, prices and settings', async () => {
    process.env.RESET_DATABASE = 'delete-everything-oct13';
    expect(await runRequestedReset()).toBe(true);
    expect(await count(`SELECT COUNT(*) n FROM users WHERE role = 'associate'`)).toBe(0);
    expect(await count(`SELECT COUNT(*) n FROM users WHERE role = 'owner'`)).toBe(1);
    expect(await count(`SELECT COUNT(*) n FROM product_types`)).toBeGreaterThan(0);
    expect(await count(`SELECT COUNT(*) n FROM products`)).toBe(0); // no demo jerseys
    expect(await count(`SELECT COUNT(*) n FROM activity_log WHERE action = 'database_reset'`)).toBe(1);
  });

  it('a restart with the same value doesn\'t wipe again', async () => {
    await pool.query(`INSERT INTO users (username, password_hash, full_name, role) VALUES ('omar', 'x', 'Omar Khalil', 'associate')`);
    process.env.RESET_DATABASE = 'delete-everything-oct13';
    expect(await runRequestedReset()).toBe(false);
    expect(await count(`SELECT COUNT(*) n FROM users WHERE username = 'omar'`)).toBe(1);
  });
});
