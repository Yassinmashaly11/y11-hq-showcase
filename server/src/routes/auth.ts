import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { COOKIE, me, requireAuth, setSessionCookie, signSession } from '../auth.js';
import { HttpError } from '../services/sales.js';
import { logActivity } from '../services/activity.js';
import { clientIp, createLoginLimiter } from '../services/login-limit.js';

export const authRoutes = Router();

const Login = z.object({ username: z.string().trim().toLowerCase(), password: z.string() });

// 10 wrong passwords for one username from one network → wait 15 minutes. Keyed on both, so associates
// on the same Wi-Fi can't lock each other out, and nobody elsewhere can lock out your login.
const limiter = createLoginLimiter();

authRoutes.post('/login', async (req, res) => {
  const { username, password } = Login.parse(req.body);
  const ip = clientIp(req);
  const key = `${ip}|${username}`;
  const wait = limiter.waitMinutes(key);
  if (wait) throw new HttpError(429, `Too many wrong passwords. Try again in ${wait} minute${wait > 1 ? 's' : ''}.`);

  const u = (await pool.query(`SELECT * FROM users WHERE username = $1`, [username])).rows[0];
  // Same message whether the username or the password is wrong, so nobody can guess usernames.
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    if (limiter.fail(key)) await logActivity(pool, null, 'login_blocked', { username, ip });
    throw new HttpError(401, 'Wrong username or password');
  }
  limiter.clear(key);
  if (!u.active) throw new HttpError(403, 'This account is no longer active');
  setSessionCookie(res, signSession({ id: u.id, role: u.role, name: u.full_name }));
  await logActivity(pool, u.id, 'login');
  res.json({ id: u.id, role: u.role, name: u.full_name });
});

authRoutes.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

authRoutes.get('/me', requireAuth, (req, res) => res.json(me(req)));
