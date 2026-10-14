import express, { NextFunction, Request, Response } from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { requireAuth } from './auth.js';
import { HttpError } from './services/sales.js';
import { authRoutes } from './routes/auth.js';
import { inventoryRoutes } from './routes/inventory.js';
import { salesRoutes } from './routes/sales.js';
import { teamRoutes } from './routes/team.js';
import { shiftRoutes } from './routes/shifts.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { settingsRoutes } from './routes/settings.js';
import { payoutRoutes } from './routes/payouts.js';
import { teamExtraRoutes } from './routes/team-extras.js';
import { businessRoutes } from './routes/business.js';
import { websiteRoutes } from './routes/website.js';
import { websiteOrderRoutes } from './routes/website-orders.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(cookieParser());

  // Railway's health check. `version` is the Git commit it's running, so you can tell when a deploy has landed.
  app.get('/api/health', (_req, res) => res.json({ ok: true, version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local' }));

  // Recruiter demo: a separate copy of Y11 HQ with fake data, reset every night.
  // The login screen shows one-click demo buttons when DEMO_MODE=true.
  app.get('/api/config', (_req, res) => {
    // Only ever on the separate demo copy: it shares the demo CEO password with visitors.
    const demo = process.env.DEMO_MODE === 'true' && process.env.SEED_DEMO_DATA === 'true';
    res.json({
      demoMode: demo,
      demoLogins: demo
        ? { ceo: { username: process.env.OWNER_USERNAME ?? 'yassin', password: process.env.OWNER_PASSWORD }, associate: { username: 'yusuf', password: 'demo1234' } }
        : null,
    });
  });
  app.use('/api/auth', authRoutes);
  // The Y11 website's backend: its own shared key instead of a login.
  app.use('/api/website', websiteRoutes);

  // Everything below needs a logged-in user.
  const api = express.Router();
  api.use(requireAuth);
  api.use(inventoryRoutes, salesRoutes, shiftRoutes, dashboardRoutes);
  api.use(payoutRoutes, teamExtraRoutes, businessRoutes, websiteOrderRoutes);
  api.use(teamRoutes);      // CEO only (checked inside)
  api.use(settingsRoutes);  // CEO only (checked inside)
  app.use('/api', api);

  // In production the same server also serves the built React app.
  const web = fileURLToPath(new URL('../../client/dist', import.meta.url));
  if (existsSync(web)) {
    app.use(express.static(web));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(`${web}/index.html`));
  }

  // One place that turns errors into clear messages for the screens.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message ?? 'Invalid input' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });
  return app;
}
