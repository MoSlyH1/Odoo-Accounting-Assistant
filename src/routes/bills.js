import { Router } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { asyncHandler, AppError } from '../utils/errors.js';
import { catalog, findPartners } from '../services/odoo/catalog.js';
import { createDraft } from '../services/odoo/bills.js';
import { extractBill } from '../services/ai/index.js';
import * as history from '../db/history.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.upload.maxBytes, files: 1 },
  fileFilter: (_req, file, cb) =>
    config.upload.mimeTypes.includes(file.mimetype)
      ? cb(null, true)
      : cb(new AppError(`Unsupported file type ${file.mimetype}. Upload a JPG, PNG, WEBP, HEIC or PDF.`)),
});

// Step 1: read the bill with AI and return an editable proposal.
router.post('/extract', upload.single('file'), asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError('Attach a bill image or PDF.');
  const base64 = req.file.buffer.toString('base64');
  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

  const [cat, previous] = await Promise.all([catalog(), history.findByHash(fileHash).catch(() => null)]);
  const { bill, model } = await extractBill({ base64, mimeType: req.file.mimetype, catalog: cat });

  // Suggest an Odoo vendor and reuse the account you picked for them last time.
  const matches = bill.vendor.name ? await findPartners(bill.vendor.name, 5).catch(() => []) : [];
  const vatMatch = bill.vendor.vat ? (await findPartners(bill.vendor.vat, 1).catch(() => []))[0] : null;
  const partner = vatMatch || matches[0] || null;
  if (partner) {
    const preferred = await history.preferredAccount(partner.id).catch(() => null);
    if (preferred) {
      for (const l of bill.lines) {
        l.accountId = preferred;
        l.accountReason = 'Used last time for this vendor';
      }
      bill.warnings = bill.warnings.filter((w) => !w.startsWith('Pick an account'));
    }
  }

  const historyId = await history.saveExtraction({ fileName: req.file.originalname, fileHash, extracted: bill, model }).catch(() => null);
  if (previous) {
    bill.warnings.unshift(`This exact file already created a draft on ${new Date(previous.created_at).toLocaleDateString('en-GB')}.`);
  }

  res.json({ bill, partner, partnerOptions: matches, model, historyId, duplicateOf: previous });
}));

// Step 2: create the draft in Odoo from the reviewed data.
router.post('/', asyncHandler(async (req, res) => {
  const { historyId, ...bill } = req.body || {};
  try {
    const result = await createDraft(bill);
    await history.markDrafted(historyId, {
      submitted: { ...bill, file: bill.file ? { name: bill.file.name, mimeType: bill.file.mimeType } : null },
      moveId: result.moveId,
      url: result.url,
    }).catch(() => {});
    if (bill.kind !== 'entry') {
      await history.rememberVendorAccounts(result.partnerId, bill.lines.map((l) => Number(l.accountId))).catch(() => {});
    }
    res.status(201).json(result);
  } catch (e) {
    if (e.status !== 409) await history.markFailed(historyId, e.message).catch(() => {});
    throw e;
  }
}));

router.get('/history', asyncHandler(async (_req, res) => {
  res.json({ enabled: Boolean(config.db.url), items: await history.recentBills(40) });
}));

export default router;
