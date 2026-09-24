import { query, dbEnabled } from './index.js';

export async function saveExtraction({ fileName, fileHash, extracted, model }) {
  if (!dbEnabled()) return null;
  const { rows } = await query(
    `INSERT INTO bills (file_name, file_hash, extracted, ai_model) VALUES ($1,$2,$3,$4) RETURNING id`,
    [fileName, fileHash, extracted, model]
  );
  return rows[0].id;
}

export async function findByHash(fileHash) {
  if (!dbEnabled()) return null;
  const { rows } = await query(
    `SELECT id, odoo_move_id, odoo_url, created_at FROM bills WHERE file_hash=$1 AND status='drafted' ORDER BY id DESC LIMIT 1`,
    [fileHash]
  );
  return rows[0] || null;
}

export async function markDrafted(id, { submitted, moveId, url }) {
  if (!dbEnabled() || !id) return;
  await query(
    `UPDATE bills SET status='drafted', submitted=$2, odoo_move_id=$3, odoo_url=$4, error=NULL, updated_at=now() WHERE id=$1`,
    [id, submitted, moveId, url]
  );
}

export async function markFailed(id, error) {
  if (!dbEnabled() || !id) return;
  await query(`UPDATE bills SET status='failed', error=$2, updated_at=now() WHERE id=$1`, [id, String(error).slice(0, 2000)]);
}

export async function recentBills(limit = 30) {
  if (!dbEnabled()) return [];
  const { rows } = await query(
    `SELECT id, file_name, status, odoo_move_id, odoo_url, error, created_at,
            extracted->'vendor'->>'name' AS vendor, extracted->>'total' AS total, extracted->>'currency' AS currency
       FROM bills ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function rememberVendorAccounts(partnerId, accountIds) {
  if (!dbEnabled() || !partnerId) return;
  for (const accountId of new Set(accountIds.filter(Boolean))) {
    await query(
      `INSERT INTO vendor_accounts (partner_id, account_id) VALUES ($1,$2)
       ON CONFLICT (partner_id, account_id) DO UPDATE SET uses = vendor_accounts.uses + 1, last_used = now()`,
      [partnerId, accountId]
    );
  }
}

export async function preferredAccount(partnerId) {
  if (!dbEnabled() || !partnerId) return null;
  const { rows } = await query(
    `SELECT account_id FROM vendor_accounts WHERE partner_id=$1 ORDER BY uses DESC, last_used DESC LIMIT 1`,
    [partnerId]
  );
  return rows[0]?.account_id || null;
}
