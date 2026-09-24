import { migrate, dbEnabled, getPool } from './index.js';

if (!dbEnabled()) {
  console.log('DATABASE_URL is not set — nothing to migrate.');
  process.exit(0);
}
await migrate();
console.log('Migrations applied.');
await getPool().end();
