import app from './app.js';
import { config, missingConfig } from './config.js';
import { migrate, dbEnabled } from './db/index.js';

const missing = missingConfig();
if (missing.length) console.warn(`⚠ Missing environment variables: ${missing.join(', ')}`);

if (dbEnabled()) {
  migrate().then(() => console.log('Database ready.')).catch((e) => console.error('Migration failed:', e.message));
}

app.listen(config.port, () => console.log(`Bill Agent running on http://localhost:${config.port}`));
