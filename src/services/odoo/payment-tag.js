// A bill that was already paid when it was scanned gets a short note in its Internal Notes.
// The note is readable for people and machine-readable for the Payments tab, so the plan
// survives page reloads and needs no database: Odoo itself is the source of truth.
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function paymentTag({ journalId, journalName, date, amount }) {
  const human = `Bill Agent: already paid via ${journalName || 'journal ' + journalId} on ${date}${amount ? ` (${amount})` : ''}. Register the payment after posting.`;
  const machine = `[bill-agent:pay journal=${Number(journalId)} date=${date}${amount ? ` amount=${Number(amount)}` : ''}]`;
  return `<p>${esc(human)} ${machine}</p>`;
}

export function readPaymentTag(html) {
  const m = /\[bill-agent:pay journal=(\d+) date=(\d{4}-\d{2}-\d{2})(?: amount=([\d.]+))?\]/.exec(String(html || ''));
  return m ? { journalId: Number(m[1]), date: m[2], amount: m[3] ? Number(m[3]) : null } : null;
}
