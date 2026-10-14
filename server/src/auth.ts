import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { HttpError } from './services/sales.js';
import { pool } from './db/pool.js';

export const COOKIE = 'y11hq_session';

export interface SessionUser { id: number; role: 'owner' | 'associate'; name: string }

declare global {
  namespace Express { interface Request { user?: SessionUser } }
}

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET is not set');
  return s;
}

export function signSession(u: SessionUser) {
  return jwt.sign(u, secret(), { expiresIn: '7d' });
}

// The login token lives in an httpOnly cookie, so page JavaScript can't read or steal it.
export function setSessionCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 3600 * 1000,
  });
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE];
  if (!token) throw new HttpError(401, 'Please log in');
  let p: SessionUser;
  try {
    p = jwt.verify(token, secret()) as SessionUser;
  } catch {
    throw new HttpError(401, 'Your session expired. Please log in again.');
  }
  // Removed associates lose access right away, even with a valid token.
  const r = await pool.query(`SELECT active FROM users WHERE id = $1`, [p.id]);
  if (!r.rows[0]?.active) throw new HttpError(401, 'This account is no longer active');
  req.user = { id: p.id, role: p.role, name: p.name };
  next();
}

export function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'owner') throw new HttpError(403, 'Only the CEO can do this');
  next();
}

export const me = (req: Request) => req.user!;
