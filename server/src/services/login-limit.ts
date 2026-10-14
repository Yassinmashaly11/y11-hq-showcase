import type { Request } from 'express';

/**
 * The visitor's address. On Railway the edge proxy writes it to X-Real-IP on every request, replacing
 * anything the visitor sent. (X-Forwarded-For there ends with one of Railway's own proxies, which changes
 * from request to request, so it can't be used.) Anywhere else: the connection's own address.
 */
export const clientIp = (req: Request) =>
  (process.env.RAILWAY_SERVICE_ID ? req.get('x-real-ip') : undefined) ?? req.ip ?? 'unknown';

/**
 * Limits wrong-password attempts: after `max` failures for the same key within `windowMs`,
 * that key must wait until the window ends. Kept in memory: Y11 HQ runs as one server.
 */
export function createLoginLimiter({ max = 10, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const fails = new Map<string, { count: number; resetAt: number }>();
  const current = (key: string) => {
    const f = fails.get(key);
    if (f && f.resetAt <= now()) fails.delete(key);
    return fails.get(key);
  };

  return {
    /** Minutes left to wait, or 0 if this key may try again. */
    waitMinutes(key: string) {
      const f = current(key);
      return f && f.count >= max ? Math.ceil((f.resetAt - now()) / 60000) : 0;
    },
    /** Record a wrong password. Returns true when this failure starts a lockout. */
    fail(key: string) {
      // Forget expired entries now and then, so the map can't grow forever.
      if (fails.size > 1000) for (const k of fails.keys()) current(k);
      const f = current(key) ?? { count: 0, resetAt: now() + windowMs };
      f.count += 1;
      fails.set(key, f);
      return f.count === max;
    },
    /** A successful login clears the slate. */
    clear(key: string) { fails.delete(key); },
  };
}
