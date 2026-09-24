// Debit/credit preview: shows exactly how the draft will post before it reaches Odoo.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (n) => nf.format(round2(n));

export function lineSubtotal(l) {
  return round2((Number(l.quantity) || 0) * (Number(l.unitPrice) || 0));
}

export function lineTax(l, catalog) {
  return (l.taxIds || []).reduce((sum, id) => {
    const t = catalog.taxes.find((x) => x.id === Number(id));
    if (!t) return sum;
    return sum + (t.amountType === 'percent' ? lineSubtotal(l) * (t.amount / 100) : t.amount * (Number(l.quantity) || 1));
  }, 0);
}

export function billTotals(lines, catalog) {
  const untaxed = round2(lines.reduce((s, l) => s + lineSubtotal(l), 0));
  const tax = round2(lines.reduce((s, l) => s + lineTax(l, catalog), 0));
  return { untaxed, tax, total: round2(untaxed + tax) };
}

function accountLabel(id, catalog) {
  const a = (catalog.allAccounts || catalog.accounts).find((x) => x.id === Number(id));
  return a ? { code: a.code, name: a.name } : { code: '', name: 'Account not chosen' };
}

export function journalRows(bill, catalog) {
  if (bill.kind === 'entry') {
    const rows = bill.entryLines.map((l) => ({ ...accountLabel(l.accountId, catalog), memo: l.description, debit: round2(l.debit), credit: round2(l.credit), missing: !l.accountId }));
    return finish(rows);
  }

  const rows = [];
  const byAccount = new Map();
  for (const l of bill.lines) {
    const key = l.accountId || `none:${l.description}`;
    const prev = byAccount.get(key) || { accountId: l.accountId, memo: l.description, amount: 0 };
    prev.amount += lineSubtotal(l);
    byAccount.set(key, prev);
  }
  for (const g of byAccount.values()) rows.push({ ...accountLabel(g.accountId, catalog), memo: g.memo, amount: g.amount, missing: !g.accountId });

  const taxByName = new Map();
  for (const l of bill.lines) {
    for (const id of l.taxIds || []) {
      const t = catalog.taxes.find((x) => x.id === Number(id));
      if (!t) continue;
      const single = { ...l, taxIds: [id] };
      taxByName.set(t.name, (taxByName.get(t.name) || 0) + lineTax(single, catalog));
    }
  }
  for (const [name, amount] of taxByName) rows.push({ code: '', name, memo: 'Tax account set on the tax in Odoo', amount });

  const { total } = billTotals(bill.lines, catalog);
  const payable = catalog.payable || { code: '', name: 'Accounts payable' };
  const vendorName = bill.vendor?.name || 'vendor';

  const isRefund = bill.kind === 'refund';
  const out = rows.map((r) => ({ ...r, debit: isRefund ? 0 : round2(r.amount), credit: isRefund ? round2(r.amount) : 0 }));
  out.push({ code: payable.code, name: payable.name, memo: vendorName, debit: isRefund ? total : 0, credit: isRefund ? 0 : total });
  return finish(out);
}

function finish(rows) {
  const debit = round2(rows.reduce((s, r) => s + r.debit, 0));
  const credit = round2(rows.reduce((s, r) => s + r.credit, 0));
  return { rows, debit, credit, balanced: debit === credit && debit > 0 };
}

// Turns a bill into editable journal-entry lines (used when switching to "Journal entry").
export function billToEntryLines(bill, catalog) {
  const lines = bill.lines.map((l) => ({ description: l.description, accountId: l.accountId, debit: lineSubtotal(l), credit: 0 }));
  const { tax, total } = billTotals(bill.lines, catalog);
  if (tax) lines.push({ description: 'VAT on purchases', accountId: null, debit: tax, credit: 0 });
  lines.push({ description: bill.vendor?.name || 'Vendor', accountId: catalog.payable?.id || null, debit: 0, credit: total });
  if (bill.kind === 'refund') for (const l of lines) [l.debit, l.credit] = [l.credit, l.debit];
  return lines;
}
