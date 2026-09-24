import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { config, missingConfig } from './config.js';
import { requireAuth } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import odooRoutes from './routes/odoo.js';
import billRoutes from './routes/bills.js';

const app = express();
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '6mb' }));

app.get('/api/health', (_req, res) => {
  const missing = missingConfig();
  res.json({
    ok: missing.length === 0,
    missing,
    aiProvider: config.ai.provider,
    history: Boolean(config.db.url),
    autoCreatePartner: config.odoo.autoCreatePartner,
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/odoo', requireAuth, odooRoutes);
app.use('/api/bills', requireAuth, billRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));

// Local / Docker: serve the frontend. On Vercel, /public is served by the CDN.
app.use(express.static(path.join(root, 'public')));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  let status = err.status || 500;
  let message = err.message || 'Something went wrong.';
  if (err instanceof multer.MulterError) {
    status = 413;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'File is larger than 4 MB. Retake the photo or scan at a lower resolution.' : message;
  }
  if (err.type === 'entity.too.large') {
    status = 413;
    message = 'Request is too large. Use a smaller image.';
  }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message, details: err.details });
});

export default app;
