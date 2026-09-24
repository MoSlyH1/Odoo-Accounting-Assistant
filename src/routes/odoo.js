import { Router } from 'express';
import { asyncHandler } from '../utils/errors.js';
import { catalog, findPartners, clearCache, accounts } from '../services/odoo/catalog.js';
import { version } from '../services/odoo/client.js';

const router = Router();

router.get('/catalog', asyncHandler(async (req, res) => {
  if (req.query.refresh) clearCache();
  const data = await catalog();
  // Journal entries can use any account, not only expense ones.
  if (req.query.allAccounts) data.allAccounts = await accounts({ all: true });
  res.json(data);
}));

router.get('/partners', asyncHandler(async (req, res) => {
  res.json(await findPartners(req.query.q, 10));
}));

router.get('/version', asyncHandler(async (_req, res) => res.json(await version())));

export default router;
