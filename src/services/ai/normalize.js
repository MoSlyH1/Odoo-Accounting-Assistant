// Cleans the model's JSON into a predictable shape and checks the arithmetic.
const AR_DIGITS = { '٠': 0, '١': 1, '٢': 2, '٣': 3, '٤': 4, '٥': 5, '٦': 6, '٧': 7, '٨': 8, '٩': 9, '۰': 0, '۱': 1, '۲': 2, '۳': 3, '۴': 4, '۵': 5, '۶': 6, '۷': 7, '۸': 8, '۹': 9 };

export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null) return 0;
  let s = String(v).replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d]).replace(/٫/g, '.').replace(/[٬,\s]/g, '');
  s = s.replace(/[^\d.-]/g, '');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

const round2 = (n) => Math.round(n * 100) / 100;
const str = (v) => (v == null ? '' : String(v).trim());
// Western digits for identifiers so they match what's typed in Odoo.
const digits = (v) => str(v).replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d]);
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(digits(v)) ? digits(v) : '');

// Balanced-brace substring starting at `from` (ignoring braces inside strings), or null if
// the text runs out before the object closes (a truncated reply).
function balancedObjectAt(text, from) {
  let depth = 0, inString = false, escaped = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

// Pulls the JSON object out of a model reply that may also contain chain-of-thought,
// markdown fences, or trailing commentary. A model sometimes uses "{" in plain prose
// before the real object (quoting the document, emphasis), so this tries every "{" in
// turn and keeps the first one that actually parses, rather than trusting the first brace.
export function parseModelJson(text) {
  const clean = String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```json|```/gi, '')
    .trim();
  let sawTruncated = false;
  for (let i = clean.indexOf('{'); i !== -1; i = clean.indexOf('{', i + 1)) {
    const candidate = balancedObjectAt(clean, i);
    if (candidate == null) { sawTruncated = true; continue; }
    try {
      return JSON.parse(candidate);
    } catch { /* not this one — keep scanning */ }
  }
  throw new Error(sawTruncated ? 'truncated' : 'no valid JSON object found');
}

export function normalize(raw, { accounts = [], taxes = [] } = {}) {
  const accountIds = new Set(accounts.map((a) => a.id));
  const warnings = [];

  const lines = (Array.isArray(raw.lines) ? raw.lines : []).map((l) => {
    const taxRate = toNumber(l.tax_rate);
    const tax = taxes.find((t) => t.amountType === 'percent' && Math.abs(t.amount - taxRate) < 0.01);
    const accountId = accountIds.has(Number(l.account_id)) ? Number(l.account_id) : null;
    return {
      description: str(l.description) || '/',
      quantity: toNumber(l.quantity) || 1,
      unitPrice: round2(toNumber(l.unit_price)),
      taxRate,
      taxIds: taxRate > 0 && tax ? [tax.id] : [],
      accountId,
      accountReason: str(l.account_reason),
    };
  });

  const docTypeRaw = raw.document_type;
  const isPayment = docTypeRaw === 'payment';
  const total = round2(toNumber(raw.total));
  if (!lines.length && total && !isPayment) {
    lines.push({ description: 'Purchase', quantity: 1, unitPrice: total, taxRate: 0, taxIds: [], accountId: null, accountReason: '' });
  }

  for (const l of lines) {
    if (l.taxRate > 0 && !l.taxIds.length) warnings.push(`No ${l.taxRate}% purchase tax exists in Odoo — pick one manually.`);
    if (!l.accountId) warnings.push(`Pick an account for "${l.description}".`);
  }

  const subtotal = round2(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0));
  const taxTotal = round2(lines.reduce((s, l) => s + l.quantity * l.unitPrice * (l.taxRate / 100), 0));
  const computed = raw.tax_included_in_prices ? subtotal : round2(subtotal + taxTotal);
  if (!isPayment && total && Math.abs(computed - total) > Math.max(0.05, total * 0.005)) {
    warnings.push(`Lines add up to ${computed}, but the document total is ${total}. Check quantities and prices.`);
  }
  if (raw.tax_included_in_prices) warnings.push('Prices on the document include VAT — make sure the chosen taxes are "included in price" or adjust the unit prices.');

  const docType = ['bill', 'refund', 'receipt', 'payment', 'other'].includes(raw.document_type) ? raw.document_type : 'bill';
  const pay = raw.payment || {};
  const payStatus = isPayment ? 'paid' : ['paid', 'partial', 'unpaid'].includes(pay.status) ? pay.status : 'unknown';
  const payAmount = round2(toNumber(pay.amount)) || (isPayment || payStatus === 'paid' ? total : 0);
  const confidence = Math.max(0, Math.min(1, toNumber(raw.confidence)));
  if (confidence && confidence < 0.6) warnings.push('The AI is not confident about this document. Review every field.');

  return {
    kind: docType === 'refund' ? 'refund' : docType === 'payment' ? 'payment' : 'bill',
    documentType: docType,
    language: str(raw.language) || 'en',
    vendor: {
      name: str(raw.vendor?.name),
      nameOriginal: str(raw.vendor?.name_original),
      vat: digits(raw.vendor?.vat),
      phone: digits(raw.vendor?.phone),
      address: str(raw.vendor?.address),
    },
    ref: digits(raw.bill_number),
    date: isoDate(raw.date),
    dueDate: isoDate(raw.due_date),
    currency: str(raw.currency).toUpperCase() || '',
    lines,
    subtotal: round2(toNumber(raw.subtotal)) || subtotal,
    taxTotal: round2(toNumber(raw.tax_total)) || taxTotal,
    total: total || computed,
    payment: {
      status: payStatus,
      method: ['cash', 'bank_transfer', 'card', 'cheque', 'other'].includes(pay.method) ? pay.method : '',
      amount: payAmount,
      reference: digits(pay.reference),
    },
    confidence,
    notes: str(raw.notes),
    warnings: [...new Set(warnings)],
  };
}
