// Vendor payments: draft payments from scanned payment documents, and registering payments
// on posted bills through Odoo's own "Register Payment" wizard (so bills are matched and
// marked paid exactly like doing it by hand).
import { call, create, searchRead, recordUrl } from './client.js';
import { currencies, paymentJournals } from './catalog.js';
import { resolvePartner, attachFile } from './bills.js';
import { readPaymentTag } from './payment-tag.js';
import { AppError } from '../../utils/errors.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const today = () => new Date().toISOString().slice(0, 10);

// Odoo 18 renamed account.payment "ref" to "memo"; check once which one exists.
let memoField = null;
async function paymentMemoField() {
  if (!memoField) {
    memoField = call('account.payment', 'fields_get', [['memo', 'ref']], { attributes: ['type'] })
      .then((f) => (f.memo ? 'memo' : f.ref ? 'ref' : null))
      .catch(() => 'ref');
  }
  return memoField;
}

async function currencyId(code) {
  if (!code) return null;
  return (await currencies()).find((c) => c.code.toUpperCase() === String(code).toUpperCase())?.id || null;
}

/* ---------- open bills (for the Payments tab and for linking a scanned payment) ---------- */

export async function openBills({ q, partnerId, limit = 200 } = {}) {
  const domain = [
    ['move_type', '=', 'in_invoice'],
    ['state', '=', 'posted'],
    ['payment_state', 'in', ['not_paid', 'partial']],
  ];
  if (partnerId) domain.push(['partner_id', '=', Number(partnerId)]);
  if (q?.trim()) domain.push('|', '|', ['partner_id.name', 'ilike', q.trim()], ['ref', 'ilike', q.trim()], ['name', 'ilike', q.trim()]);
  const rows = await searchRead('account.move', domain, [
    'id', 'name', 'ref', 'partner_id', 'invoice_date', 'invoice_date_due',
    'amount_total', 'amount_residual', 'currency_id', 'payment_state', 'narration',
  ], { limit, order: 'invoice_date_due asc, id asc' });
  return rows.map((m) => ({
    id: m.id,
    name: m.name,
    ref: m.ref || '',
    partnerId: m.partner_id?.[0],
    partner: m.partner_id?.[1] || '',
    date: m.invoice_date || '',
    dueDate: m.invoice_date_due || '',
    total: m.amount_total,
    residual: m.amount_residual,
    currency: m.currency_id?.[1] || '',
    paymentState: m.payment_state,
    plannedPayment: readPaymentTag(m.narration), // set when the bill was scanned as "already paid"
    url: recordUrl('account.move', m.id),
  }));
}

/* ---------- register payments on posted bills ---------- */

function idsFromAction(action) {
  if (!action || typeof action !== 'object') return [];
  if (action.res_id) return [action.res_id];
  const inDomain = (action.domain || []).find((d) => Array.isArray(d) && d[0] === 'id' && d[1] === 'in');
  return inDomain ? inDomain[2] : [];
}

/**
 * Runs Odoo's Register Payment on one or more posted bills of the same vendor.
 * { moveIds, journalId, date, amount?, memo?, group? }
 */
export async function registerPayment({ moveIds, journalId, date, amount, memo, group = true }) {
  const ids = (moveIds || []).map(Number).filter(Boolean);
  if (!ids.length) throw new AppError('Choose at least one bill to pay.');
  if (!journalId) throw new AppError('Choose the bank or cash journal the money was paid from.');

  const bills = await searchRead('account.move', [['id', 'in', ids]], ['id', 'name', 'state', 'payment_state', 'amount_residual', 'narration']);
  const notPosted = bills.filter((b) => b.state !== 'posted');
  if (notPosted.length) {
    throw new AppError(`${notPosted.map((b) => b.name || `#${b.id}`).join(', ')} must be posted in Odoo before a payment can be registered.`);
  }

  const context = { active_model: 'account.move', active_ids: ids };
  const values = { journal_id: Number(journalId), payment_date: isDate(date) ? date : today() };
  if (ids.length === 1 && Number(amount) > 0) values.amount = round2(amount); // partial payment allowed
  if (memo) values.communication = memo;
  if (ids.length > 1) values.group_payment = Boolean(group);

  const wizardId = await create('account.payment.register', values, { context });
  const action = await call('account.payment.register', 'action_create_payments', [[wizardId]], { context });

  // The "paid at scan" plan is now done — clear it so it can never be registered twice.
  for (const b of bills) {
    if (readPaymentTag(b.narration)) {
      const narration = String(b.narration).replace(/\s*\[bill-agent:pay[^\]]*\]/, ' (payment registered)');
      await call('account.move', 'write', [[b.id], { narration }]).catch(() => {});
    }
  }

  const after = await searchRead('account.move', [['id', 'in', ids]], ['id', 'name', 'payment_state', 'amount_residual']);
  return {
    paymentIds: idsFromAction(action),
    bills: after.map((b) => ({ id: b.id, name: b.name, paymentState: b.payment_state, residual: b.amount_residual })),
  };
}

/* ---------- draft payment from a scanned payment document ---------- */

/**
 * bill = { kind:'payment', partnerId?, vendor?, ref, date, currency, file, allowDuplicate,
 *          payment: { journalId, amount, direction:'outbound'|'inbound', linkedBillId? } }
 */
export async function createPayment(bill) {
  const p = bill.payment || {};
  const amount = round2(p.amount);
  if (!(amount > 0)) throw new AppError('Enter the amount that was paid.');
  if (!p.journalId) throw new AppError('Choose the bank or cash journal the money was paid from.');
  const date = isDate(bill.date) ? bill.date : today();

  // Paying a specific posted bill: use Odoo's Register Payment so the bill is marked paid.
  if (p.linkedBillId) {
    const res = await registerPayment({ moveIds: [p.linkedBillId], journalId: p.journalId, date, amount, memo: bill.ref });
    const billInfo = res.bills[0];
    let attachmentId = null;
    if (res.paymentIds[0]) attachmentId = await attachFile('account.payment', res.paymentIds[0], bill.file).catch(() => null);
    return {
      kind: 'registered',
      moveId: res.paymentIds[0] || null,
      name: billInfo?.name,
      state: billInfo?.paymentState,
      url: recordUrl('account.move', Number(p.linkedBillId)),
      partnerId: null,
      attachmentId,
      warnings: billInfo?.paymentState === 'partial' ? [`${billInfo.name} is now partially paid (${billInfo.residual} still open).`] : [],
    };
  }

  const partner = await resolvePartner(bill);
  if (!partner.id) throw new AppError('Choose a vendor — no match was found in Odoo and auto-create is off.');

  if (!bill.allowDuplicate) {
    const [dup] = await searchRead('account.payment', [
      ['partner_id', '=', partner.id], ['amount', '=', amount], ['date', '=', date],
      ['state', 'not in', ['cancel', 'canceled', 'cancelled']],
    ], ['id', 'name'], { limit: 1 }).catch(() => []);
    if (dup) {
      throw new AppError(`A payment of ${amount} to this vendor on ${date} already exists (${dup.name && dup.name !== '/' ? dup.name : 'draft #' + dup.id}).`, 409, {
        duplicateId: dup.id,
        url: recordUrl('account.payment', dup.id),
      });
    }
  }

  const values = {
    payment_type: p.direction === 'inbound' ? 'inbound' : 'outbound',
    partner_type: 'supplier',
    partner_id: partner.id,
    amount,
    date,
    journal_id: Number(p.journalId),
  };
  const cur = await currencyId(bill.currency);
  const warnings = [];
  if (bill.currency && !cur) warnings.push(`${bill.currency} is not active in Odoo — the payment uses the journal currency.`);
  else if (cur) values.currency_id = cur;
  const memo = await paymentMemoField();
  if (memo && bill.ref) values[memo] = bill.ref;

  const paymentId = await create('account.payment', values);
  let attachmentId = null;
  try {
    attachmentId = await attachFile('account.payment', paymentId, bill.file);
  } catch (e) {
    warnings.push(`Payment created, but the scan could not be attached: ${e.message}`);
  }
  const [row] = await searchRead('account.payment', [['id', '=', paymentId]], ['name', 'state']).catch(() => []);
  return {
    kind: 'payment',
    moveId: paymentId,
    name: row?.name && row.name !== '/' ? row.name : 'Draft payment',
    state: row?.state || 'draft',
    url: recordUrl('account.payment', paymentId),
    partnerId: partner.id,
    partnerCreated: partner.created,
    attachmentId,
    warnings,
  };
}

export { paymentJournals };
