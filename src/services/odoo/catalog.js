// Reference data pulled from Odoo (accounts, taxes, journals, currencies), cached briefly.
import { searchRead, call } from './client.js';
import { config } from '../../config.js';

const TTL = 10 * 60 * 1000;
const cache = new Map();

async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - TTL) return hit.value;
  const value = await loader();
  cache.set(key, { value, at: Date.now() });
  return value;
}

export const clearCache = () => cache.clear();

// Accounts a purchase can reasonably land on (expenses, cost of sales, assets, prepaid).
const BILL_ACCOUNT_TYPES = ['expense', 'expense_direct_cost', 'expense_depreciation', 'asset_current', 'asset_non_current', 'asset_fixed', 'asset_prepayments'];

export function accounts({ all = false } = {}) {
  return cached(`accounts:${all}`, async () => {
    const fields = ['id', 'code', 'name', 'account_type'];
    const domain = all ? [] : [['account_type', 'in', BILL_ACCOUNT_TYPES]];
    let rows;
    try {
      rows = await searchRead('account.account', domain, fields, { order: 'code asc' });
    } catch {
      rows = await searchRead('account.account', [], fields, { order: 'code asc' }); // older schemas
    }
    return rows.map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.account_type }));
  });
}

export function purchaseTaxes() {
  return cached('taxes', async () => {
    const rows = await searchRead('account.tax', [['type_tax_use', '=', 'purchase']], ['id', 'name', 'amount', 'amount_type']);
    return rows.map((t) => ({ id: t.id, name: t.name, amount: t.amount, amountType: t.amount_type }));
  });
}

export function journals() {
  return cached('journals', async () => {
    const rows = await searchRead('account.journal', [['type', 'in', ['purchase', 'general']]], ['id', 'name', 'code', 'type']);
    return rows.map((j) => ({ id: j.id, name: j.name, code: j.code, type: j.type }));
  });
}

export function currencies() {
  return cached('currencies', async () => {
    const rows = await searchRead('res.currency', [], ['id', 'name', 'symbol']);
    return rows.map((c) => ({ id: c.id, code: c.name, symbol: c.symbol }));
  });
}

export function company() {
  return cached('company', async () => {
    const domain = config.odoo.companyId ? [['id', '=', config.odoo.companyId]] : [];
    const [c] = await searchRead('res.company', domain, ['id', 'name', 'currency_id'], { limit: 1 });
    return c ? { id: c.id, name: c.name, currencyId: c.currency_id?.[0], currency: c.currency_id?.[1] } : null;
  });
}

export async function findPartners(q, limit = 8) {
  if (!q?.trim()) return [];
  const term = q.trim();
  const rows = await searchRead(
    'res.partner',
    ['|', '|', ['name', 'ilike', term], ['vat', 'ilike', term], ['ref', 'ilike', term]],
    ['id', 'name', 'vat'],
    { limit, order: 'supplier_rank desc, name asc' }
  ).catch(() => searchRead('res.partner', [['name', 'ilike', term]], ['id', 'name', 'vat'], { limit }));
  return rows.map((p) => ({ id: p.id, name: p.name, vat: p.vat || '' }));
}

// Payable account for the preview (the credit side of a bill).
export function payableAccount() {
  return cached('payable', async () => {
    const [a] = await searchRead('account.account', [['account_type', '=', 'liability_payable']], ['id', 'code', 'name'], { limit: 1 });
    return a ? { id: a.id, code: a.code, name: a.name } : null;
  });
}

export async function catalog() {
  const [acc, taxes, jr, cur, comp, payable] = await Promise.all([
    accounts(), purchaseTaxes(), journals(), currencies(), company(), payableAccount(),
  ]);
  return { accounts: acc, taxes, journals: jr, currencies: cur, company: comp, payable };
}

export { call };
