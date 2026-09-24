import { Router } from 'express';
import { asyncHandler, AppError } from '../utils/errors.js';
import { openBills, registerPayment } from '../services/odoo/payments.js';

const router = Router();

// Posted vendor bills that are not fully paid yet.
router.get('/bills', asyncHandler(async (req, res) => {
  res.json(await openBills({ q: req.query.q, partnerId: req.query.partnerId }));
}));

/**
 * Register payments on posted bills.
 * body: { items: [{ moveId, journalId, date, amount? }], groupByVendor?: boolean }
 * Each item (or each vendor group) is registered separately, so one failure doesn't stop the rest.
 */
router.post('/register', asyncHandler(async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) throw new AppError('Choose at least one bill to pay.');

  const groups = [];
  if (req.body.groupByVendor) {
    const byKey = new Map();
    for (const it of items) {
      const key = `${it.partnerId}|${it.journalId}|${it.date}`;
      if (!byKey.has(key)) byKey.set(key, { ...it, moveIds: [] });
      byKey.get(key).moveIds.push(it.moveId);
    }
    groups.push(...byKey.values());
  } else {
    groups.push(...items.map((it) => ({ ...it, moveIds: [it.moveId] })));
  }

  const results = [];
  for (const g of groups) {
    try {
      const r = await registerPayment({
        moveIds: g.moveIds,
        journalId: g.journalId,
        date: g.date,
        amount: g.moveIds.length === 1 ? g.amount : undefined,
        group: true,
      });
      results.push({ moveIds: g.moveIds, ok: true, ...r });
    } catch (e) {
      results.push({ moveIds: g.moveIds, ok: false, error: e.message });
    }
  }
  res.json({ results });
}));

export default router;
