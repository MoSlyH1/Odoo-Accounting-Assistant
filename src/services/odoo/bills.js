// Turns a reviewed bill into an Odoo draft (account.move) with the scan attached.
import { call, create, searchRead, recordUrl } from './client.js';
import { currencies, company, findPartners, paymentJournals } from './catalog.js';
import { paymentTag } from './payment-tag.js';
import { config } from '../../config.js';
import { AppError } from '../../utils/errors.js';

const MOVE_TYPES = { bill: 'in_invoice', refund: 'in_refund', entry: 'entry' };
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export async function resolvePartner({ partnerId, vendor }) {
  if (partnerId) return { id: Number(partnerId), created: false };
  const name = vendor?.name?.trim();
  if (!name) return { id: null, created: false };

  if (vendor.vat) {
    const byVat = await searchRead('res.partner', [['vat', '=', vendor.vat]], ['id'], { limit: 1 });
    if (byVat[0]) return { id: byVat[0].id, created: false };
  }
  const [match] = await findPartners(name, 1);
  if (match) return { id: match.id, created: false };
  if (!config.odoo.autoCreatePartner) return { id: null, created: false };

  const values = { name, is_company: true, supplier_rank: 1 };
  if (vendor.vat) values.vat = vendor.vat;
  if (vendor.phone) values.phone = vendor.phone;
  if (vendor.address) values.street = vendor.address;
  try {
    return { id: await create('res.partner', values), created: true };
  } catch {
    // VAT validation can reject foreign/odd formats — retry without it.
    delete values.vat;
    return { id: await create('res.partner', values), created: true };
  }
}

async function resolveCurrency(code) {
  if (!code) return null;
  const c = (await currencies()).find((x) => x.code.toUpperCase() === String(code).toUpperCase());
  return c?.id || null;
}

async function findDuplicate({ moveType, partnerId, ref }) {
  if (!partnerId || !ref) return null;
  const [dup] = await searchRead(
    'account.move',
    [['move_type', '=', moveType], ['partner_id', '=', partnerId], ['ref', '=', ref], ['state', '!=', 'cancel']],
    ['id', 'name', 'state'],
    { limit: 1 }
  );
  return dup || null;
}

function billLines(lines) {
  return lines.map((l) => {
    const v = {
      name: l.description || '/',
      quantity: Number(l.quantity) || 1,
      price_unit: Number(l.unitPrice) || 0,
      tax_ids: [[6, 0, (l.taxIds || []).map(Number)]],
    };
    if (l.accountId) v.account_id = Number(l.accountId);
    return [0, 0, v];
  });
}

function entryLines(lines, partnerId) {
  let debit = 0, credit = 0;
  const out = lines.map((l) => {
    if (!l.accountId) throw new AppError('Every journal line needs an account.');
    const d = round2(l.debit), c = round2(l.credit);
    debit += d; credit += c;
    const v = { name: l.description || '/', account_id: Number(l.accountId), debit: d, credit: c };
    if (partnerId) v.partner_id = partnerId;
    return [0, 0, v];
  });
  if (round2(debit) !== round2(credit)) {
    throw new AppError(`Debit (${round2(debit)}) and credit (${round2(credit)}) must be equal.`);
  }
  return out;
}

export async function attachFile(model, recordId, file) {
  if (!file?.base64) return null;
  const attachmentId = await create('ir.attachment', {
    name: file.name || 'bill',
    datas: file.base64,
    res_model: model,
    res_id: recordId,
    mimetype: file.mimeType || 'application/octet-stream',
  });
  // Show the scan in the chatter / side preview. Non-fatal if the version differs.
  await call(model, 'message_post', [[recordId]], {
    body: 'Scanned bill uploaded by Bill Agent',
    attachment_ids: [attachmentId],
  }).catch(() => {});
  await call(model, 'write', [[recordId], { message_main_attachment_id: attachmentId }]).catch(() => {});
  return attachmentId;
}

/**
 * bill = {
 *   kind: 'bill'|'refund'|'entry', partnerId?, vendor?, ref, date, dueDate, currency, journalId,
 *   lines: [{ description, quantity, unitPrice, accountId, taxIds }]            // bill/refund
 *          [{ description, accountId, debit, credit }]                         // entry
 *   file: { name, mimeType, base64 }, allowDuplicate
 * }
 */
export async function createDraft(bill) {
  const moveType = MOVE_TYPES[bill.kind] || 'in_invoice';
  if (!bill.lines?.length) throw new AppError('Add at least one line before creating the draft.');

  const partner = await resolvePartner(bill);
  if (moveType !== 'entry' && !partner.id) {
    throw new AppError('Choose a vendor — no match was found in Odoo and auto-create is off.');
  }

  if (!bill.allowDuplicate) {
    const dup = await findDuplicate({ moveType, partnerId: partner.id, ref: bill.ref });
    if (dup) {
      throw new AppError(`This vendor already has ${dup.name || 'a bill'} with reference "${bill.ref}".`, 409, {
        duplicateId: dup.id,
        url: recordUrl('account.move', dup.id),
      });
    }
  }

  const values = { move_type: moveType };
  if (bill.journalId) values.journal_id = Number(bill.journalId);
  if (bill.ref) values.ref = bill.ref;
  if (partner.id) values.partner_id = partner.id;

  const currencyId = await resolveCurrency(bill.currency);
  const warnings = [];
  if (bill.currency && !currencyId) {
    const comp = await company();
    warnings.push(`${bill.currency} is not active in Odoo — the draft uses ${comp?.currency || 'the company currency'}.`);
  } else if (currencyId) values.currency_id = currencyId;

  if (moveType === 'entry') {
    if (bill.date) values.date = bill.date;
    values.line_ids = entryLines(bill.lines, partner.id);
  } else {
    if (bill.date) values.invoice_date = bill.date;
    if (bill.dueDate) values.invoice_date_due = bill.dueDate;
    values.invoice_line_ids = billLines(bill.lines);
  }

  // Already paid when scanned: remember how, so the Payments tab can register it after posting.
  let plannedPayment = null;
  if (moveType === 'in_invoice' && bill.payment?.paid && bill.payment.journalId) {
    const journal = (await paymentJournals()).find((j) => j.id === Number(bill.payment.journalId));
    plannedPayment = {
      journalId: Number(bill.payment.journalId),
      journalName: journal?.name,
      date: /^\d{4}-\d{2}-\d{2}$/.test(bill.payment.date || '') ? bill.payment.date : bill.date || new Date().toISOString().slice(0, 10),
      amount: Number(bill.payment.amount) > 0 ? round2(bill.payment.amount) : null,
    };
    values.narration = paymentTag(plannedPayment);
  }

  const moveId = await create('account.move', values);
  let attachmentId = null;
  try {
    attachmentId = await attachFile('account.move', moveId, bill.file);
  } catch (e) {
    warnings.push(`Draft created, but the scan could not be attached: ${e.message}`);
  }

  const [move] = await searchRead('account.move', [['id', '=', moveId]], ['name', 'amount_total', 'state']);
  return {
    moveId,
    name: move?.name,
    total: move?.amount_total,
    state: move?.state,
    url: recordUrl('account.move', moveId),
    partnerId: partner.id,
    partnerCreated: partner.created,
    attachmentId,
    plannedPayment,
    warnings,
  };
}
