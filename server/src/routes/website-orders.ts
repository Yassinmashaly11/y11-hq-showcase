import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireOwner } from '../auth.js';
import { listWebsiteOrders } from '../services/website-orders.js';

// CEO only: website orders with everything the supplier needs (jerseys and the shipping address).
export const websiteOrderRoutes = Router();

websiteOrderRoutes.get('/website-orders', requireOwner, async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(200).catch(50).parse(req.query.limit);
  res.json(await listWebsiteOrders(pool, { limit }));
});
