import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { me, requireOwner } from '../auth.js';
import { getSettings, saveSettings } from '../services/settings.js';
import { runLevelChecks } from '../services/levels.js';
import { logActivity } from '../services/activity.js';
import { diagnoseEmail } from '../services/email.js';

export const settingsRoutes = Router();
settingsRoutes.use(['/settings', '/product-types', '/levels'], requireOwner);

const money = z.number().min(0);
const SettingsBody = z.object({
  setSize: z.number().int().min(1),
  commissionPerSet: z.tuple([money, money, money]),
  levelTargets: z.object({ level2: z.number().int().min(1), level3: z.number().int().min(1) })
    .refine((t) => t.level3 > t.level2, 'Level 3 target must be higher than Level 2'),
  periodMonths: z.number().int().min(1),
  warningMonths: z.number().int().min(1),
  inHandDays: z.number().int().min(1),
  squadDealMin: z.number().int().min(1),
  extras: z.object({
    nameNumberPrice: money, nameNumberCost: money, patchPrice: money, patchCost: money,
    bigSizePrice: money, bigSizeCost: money,
  }),
  shipping: z.object({ one: money, two: money, freeFrom: z.number().int().min(1) }),
  whatsappDiscount: money,
  lowStockAt: z.number().int().min(0),
  milestones: z.array(z.object({ jerseys: z.number().int().min(1), bonus: money })).max(10),
  shiftMaxHours: z.number().min(1).max(24),
});

settingsRoutes.get('/settings', async (_req, res) => res.json(await getSettings(pool)));

settingsRoutes.put('/settings', async (req, res) => {
  const s = SettingsBody.parse(req.body);
  await saveSettings(pool, s);
  await logActivity(pool, me(req).id, 'settings_changed', s);
  res.json(s);
});

settingsRoutes.put('/product-types/:id', async (req, res) => {
  const b = z.object({ price: money, cost: money }).parse(req.body);
  const tid = z.coerce.number().int().parse(req.params.id);
  await pool.query(`UPDATE product_types SET price = $2, cost = $3 WHERE id = $1`, [tid, b.price, b.cost]);
  await logActivity(pool, me(req).id, 'price_changed', { typeId: tid, ...b });
  res.json({ ok: true });
});

// Settings → Order emails: send a real test email and show Resend's exact answer (CEO only).
settingsRoutes.get('/settings/email-test', async (_req, res) => {
  res.json(await diagnoseEmail());
});

// The checks also run every hour on their own; this button runs them right now.
settingsRoutes.post('/levels/run-checks', async (_req, res) => {
  res.json({ changed: await runLevelChecks() });
});
