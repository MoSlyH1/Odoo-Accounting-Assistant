import { api, auth } from './api.js';
import { expandUpload, prepareSource, toBase64 } from './image.js';
import { journalRows, paymentRows, billTotals, lineSubtotal, billToEntryLines, money } from './ledger.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const MAX_PARALLEL = 2;   // bills read at the same time — stays inside free-tier per-minute limits
const MAX_ATTEMPTS = 4;   // automatic retries for a bill when the AI is busy or times out

const SETTINGS_KEY = 'billAgent.settings';
const settings = Object.assign({ billJournal: '', entryJournal: '', cashJournal: '', bankJournal: '', auto: false }, (() => {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
})());
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };

const state = { items: [], selectedId: null, catalog: null, health: null, running: 0, paused: false, pauseMsg: '', bulk: false, wake: null };
const current = () => state.items.find((i) => i.id === state.selectedId);
const today = () => new Date().toISOString().slice(0, 10);

/* ---------------- Boot & auth ---------------- */

async function boot() {
  state.health = await api.health().catch(() => null);
  if (!auth.token) return showLogin();
  showApp();
}

function showLogin(msg = '') {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#loginError').textContent = msg || (state.health && !state.health.ok ? `Server is missing: ${state.health.missing.join(', ')}` : '');
  $('#password').focus();
}

async function showApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  await loadCatalog();
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const { token } = await api.login($('#password').value);
    auth.token = token;
    $('#password').value = '';
    showApp();
  } catch (err) {
    $('#loginError').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

window.addEventListener('auth:expired', () => { auth.token = null; showLogin('Your session ended. Sign in again.'); });

async function loadCatalog(refresh = false) {
  const status = $('#odooStatus');
  status.textContent = 'Connecting…';
  status.dataset.state = 'pending';
  try {
    state.catalog = await api.catalog(refresh);
    status.textContent = state.catalog.company ? `${state.catalog.company.name}` : 'Connected';
    status.dataset.state = 'ok';
    fillSettings();
    renderReview();
  } catch (err) {
    status.textContent = 'Odoo unreachable';
    status.dataset.state = 'error';
    status.title = err.message;
  }
}

/* ---------------- Settings ---------------- */

function journalOptions(type, selected) {
  const list = (state.catalog?.journals || []).filter((j) => j.type === type);
  return list.map((j) => `<option value="${j.id}" ${String(j.id) === String(selected) ? 'selected' : ''}>${esc(j.name)} (${esc(j.code)})</option>`).join('');
}

function defaultJournal(kind) {
  const type = kind === 'entry' ? 'general' : 'purchase';
  const wanted = kind === 'entry' ? settings.entryJournal : settings.billJournal;
  const list = (state.catalog?.journals || []).filter((j) => j.type === type);
  return (list.find((j) => String(j.id) === String(wanted)) || list[0])?.id || '';
}

function paymentJournalOptions(selected, { blank = false } = {}) {
  const list = state.catalog?.paymentJournals || [];
  return (blank ? '<option value="">Choose bank or cash</option>' : '') + list.map((j) =>
    `<option value="${j.id}" ${String(j.id) === String(selected) ? 'selected' : ''}>${esc(j.name)} (${j.type === 'cash' ? 'cash' : 'bank'})</option>`).join('');
}

// Cash payments go to the cash journal, everything else to the bank journal.
function defaultPaymentJournal(method) {
  const list = state.catalog?.paymentJournals || [];
  const type = method === 'cash' ? 'cash' : 'bank';
  const wanted = type === 'cash' ? settings.cashJournal : settings.bankJournal;
  return (list.find((j) => String(j.id) === String(wanted)) || list.find((j) => j.type === type) || list[0])?.id || '';
}

const METHOD_TEXT = { cash: 'cash', bank_transfer: 'bank transfer', card: 'card', cheque: 'cheque', other: 'other' };

function fillSettings() {
  $('#setBillJournal').innerHTML = journalOptions('purchase', settings.billJournal || defaultJournal('bill'));
  $('#setEntryJournal').innerHTML = journalOptions('general', settings.entryJournal || defaultJournal('entry'));
  $('#setCashJournal').innerHTML = paymentJournalOptions(settings.cashJournal || defaultPaymentJournal('cash'));
  $('#setBankJournal').innerHTML = paymentJournalOptions(settings.bankJournal || defaultPaymentJournal('bank_transfer'));
  $('#setAuto').checked = settings.auto;
}

$('#settingsBtn').addEventListener('click', () => $('#settings').showModal());
$('#setBillJournal').addEventListener('change', (e) => { settings.billJournal = e.target.value; saveSettings(); });
$('#setEntryJournal').addEventListener('change', (e) => { settings.entryJournal = e.target.value; saveSettings(); });
$('#setCashJournal').addEventListener('change', (e) => { settings.cashJournal = e.target.value; saveSettings(); });
$('#setBankJournal').addEventListener('change', (e) => { settings.bankJournal = e.target.value; saveSettings(); });
$('#setAuto').addEventListener('change', (e) => { settings.auto = e.target.checked; saveSettings(); });
$('#refreshCatalog').addEventListener('click', async (e) => { e.target.disabled = true; await loadCatalog(true); e.target.disabled = false; });
$('#logoutBtn').addEventListener('click', () => { auth.token = null; $('#settings').close(); showLogin(); });

/* ---------------- Tabs ---------------- */

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.removeAttribute('aria-current'));
  t.setAttribute('aria-current', 'page');
  const view = t.dataset.view;
  $('#view-scan').hidden = view !== 'scan';
  $('#view-payments').hidden = view !== 'payments';
  $('#view-history').hidden = view !== 'history';
  if (view === 'history') loadHistory();
  if (view === 'payments') loadPayments();
}));

async function loadHistory() {
  const el = $('#historyList');
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const { enabled, items } = await api.history();
    if (!enabled) { el.innerHTML = '<p class="muted">History is off. Set DATABASE_URL on the server to keep a record of every scan.</p>'; return; }
    if (!items.length) { el.innerHTML = '<p class="muted">No bills yet. Scan one from the Scan tab.</p>'; return; }
    el.innerHTML = `<table class="grid"><thead><tr><th>Date</th><th>Vendor</th><th class="num">Total</th><th>Status</th><th></th></tr></thead><tbody>${items.map((b) => `
      <tr>
        <td>${esc(new Date(b.created_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }))}</td>
        <td>${esc(b.vendor || b.file_name || '—')}</td>
        <td class="num">${b.total ? `${money(b.total)} ${esc(b.currency || '')}` : '—'}</td>
        <td><span class="chip" data-status="${esc(b.status)}">${b.status === 'drafted' ? 'Draft created' : b.status === 'failed' ? 'Failed' : 'Read, not sent'}</span></td>
        <td>${b.odoo_url ? `<a href="${esc(b.odoo_url)}" target="_blank" rel="noopener">Open in Odoo</a>` : esc(b.error || '')}</td>
      </tr>`).join('')}</tbody></table>`;
  } catch (err) {
    el.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}

/* ---------------- Payments tab ---------------- */

const pay = { rows: [], sel: new Map(), loading: false };

async function loadPayments() {
  if (!state.catalog) return;
  const list = $('#payList');
  $('#payAllJournal').innerHTML = paymentJournalOptions(defaultPaymentJournal('bank_transfer'));
  if (!$('#payAllDate').value) $('#payAllDate').value = today();
  list.innerHTML = '<p class="muted">Loading open bills from Odoo…</p>';
  pay.loading = true;
  try {
    pay.rows = await api.openBills($('#paySearch').value);
  } catch (err) {
    list.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
    pay.loading = false;
    return;
  }
  pay.loading = false;
  const ids = new Set(pay.rows.map((r) => r.id));
  for (const id of [...pay.sel.keys()]) if (!ids.has(id)) pay.sel.delete(id);
  // Bills scanned as "already paid" come pre-ticked with how they were paid.
  for (const r of pay.rows) {
    // Only untouched bills: a partly paid bill already received money, so never pre-tick it.
    if (r.plannedPayment && r.paymentState === 'not_paid' && !pay.sel.has(r.id) && !r.untickedByUser) {
      pay.sel.set(r.id, {
        journalId: r.plannedPayment.journalId,
        date: r.plannedPayment.date,
        amount: Math.min(r.plannedPayment.amount || r.residual, r.residual),
      });
    }
  }
  renderPayments();
}

function renderPayments() {
  const list = $('#payList');
  if (!pay.rows.length) {
    list.innerHTML = '<div class="empty"><h2>Nothing to pay</h2><p>Every posted vendor bill is paid. Bills appear here once they are posted in Odoo.</p></div>';
    updatePaySummary();
    return;
  }
  const t = today();
  list.innerHTML = `<table class="grid pay-table">
    <thead><tr>
      <th><input type="checkbox" id="payAll" aria-label="Tick all" ${pay.sel.size === pay.rows.length ? 'checked' : ''}></th>
      <th>Vendor · bill</th><th>Due</th><th class="num">Open</th><th>Pay from</th><th>Date</th><th class="num">Amount</th>
    </tr></thead>
    <tbody>${pay.rows.map((r) => {
      const v = pay.sel.get(r.id);
      const on = Boolean(v);
      const overdue = r.dueDate && r.dueDate < t;
      return `<tr data-id="${r.id}" class="${on ? 'on' : ''}">
        <td data-label=""><input type="checkbox" data-f="tick" ${on ? 'checked' : ''} aria-label="Pay ${esc(r.name)}"></td>
        <td data-label="Bill"><strong>${esc(r.partner)}</strong><span class="memo"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.name)}</a>${r.ref ? ` · ${esc(r.ref)}` : ''}${r.paymentState === 'partial' ? ' · partly paid' : ''}</span>
          ${r.plannedPayment ? '<span class="chip" data-status="ready">Paid at scan</span>' : ''}</td>
        <td data-label="Due" class="${overdue ? 'overdue' : ''}">${esc(r.dueDate || '—')}</td>
        <td data-label="Open" class="num">${money(r.residual)} <span class="memo">${esc(r.currency)}</span></td>
        <td data-label="Pay from"><select data-f="journalId" ${on ? '' : 'disabled'}>${paymentJournalOptions(v?.journalId || $('#payAllJournal').value)}</select></td>
        <td data-label="Date"><input type="date" data-f="date" value="${esc(v?.date || $('#payAllDate').value)}" ${on ? '' : 'disabled'}></td>
        <td data-label="Amount"><input type="number" class="num" step="0.01" min="0" max="${r.residual}" data-f="amount" value="${v ? v.amount : r.residual}" ${on ? '' : 'disabled'}></td>
      </tr>`;
    }).join('')}</tbody></table>`;
  updatePaySummary();
}

function updatePaySummary() {
  const byCur = {};
  for (const [id, v] of pay.sel) {
    const r = pay.rows.find((x) => x.id === id);
    if (r) byCur[r.currency] = (byCur[r.currency] || 0) + (Number(v.amount) || 0);
  }
  const n = pay.sel.size;
  $('#paySummary').textContent = n
    ? `${n} bill${n === 1 ? '' : 's'} ticked · ${Object.entries(byCur).map(([c, a]) => `${money(a)} ${c}`).join(' + ')}`
    : `${pay.rows.length} open bill${pay.rows.length === 1 ? '' : 's'}`;
  $('#payRegister').disabled = !n;
  $('#payRegister').textContent = n ? `Register ${n} payment${n === 1 ? '' : 's'}` : 'Register payments';
}

$('#payList').addEventListener('change', (e) => {
  if (e.target.id === 'payAll') {
    if (e.target.checked) for (const r of pay.rows) {
      if (!pay.sel.has(r.id)) pay.sel.set(r.id, { journalId: Number($('#payAllJournal').value), date: $('#payAllDate').value, amount: r.residual });
    } else pay.sel.clear();
    return renderPayments();
  }
  const row = e.target.closest('tr[data-id]');
  if (!row) return;
  const id = Number(row.dataset.id);
  const r = pay.rows.find((x) => x.id === id);
  const f = e.target.dataset.f;
  if (f === 'tick') {
    if (e.target.checked) pay.sel.set(id, { journalId: Number($('#payAllJournal').value), date: $('#payAllDate').value, amount: r.residual });
    else { pay.sel.delete(id); r.untickedByUser = true; }
    return renderPayments();
  }
  const v = pay.sel.get(id);
  if (!v) return;
  if (f === 'journalId') v.journalId = Number(e.target.value);
  if (f === 'date') v.date = e.target.value;
  if (f === 'amount') v.amount = Math.min(parseFloat(e.target.value) || 0, r.residual);
  updatePaySummary();
});

$('#payApplyAll').addEventListener('click', () => {
  for (const v of pay.sel.values()) {
    v.journalId = Number($('#payAllJournal').value);
    v.date = $('#payAllDate').value;
  }
  renderPayments();
});

let paySearchTimer;
$('#paySearch').addEventListener('input', () => { clearTimeout(paySearchTimer); paySearchTimer = setTimeout(loadPayments, 350); });
$('#payRefresh').addEventListener('click', loadPayments);

$('#payRegister').addEventListener('click', async () => {
  const items = [...pay.sel].map(([moveId, v]) => {
    const r = pay.rows.find((x) => x.id === moveId);
    return { moveId, partnerId: r?.partnerId, journalId: v.journalId, date: v.date, amount: v.amount };
  });
  if (items.some((i) => !i.journalId)) { payNote('Choose a bank or cash journal for every ticked bill.', 'error'); return; }
  if (items.some((i) => !(i.amount > 0))) { payNote('Every ticked bill needs an amount above zero.', 'error'); return; }
  const btn = $('#payRegister');
  btn.disabled = true;
  btn.textContent = 'Registering in Odoo…';
  try {
    const { results } = await api.registerPayments({ items, groupByVendor: $('#payGroup').checked });
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    for (const r of ok) for (const id of r.moveIds) pay.sel.delete(id);
    const paidBills = ok.reduce((n, r) => n + r.moveIds.length, 0);
    payNote(
      `${paidBills} bill${paidBills === 1 ? '' : 's'} paid in Odoo.` + (bad.length ? ` ${bad.length} failed: ${bad.map((r) => r.error).join(' · ')}` : ''),
      bad.length ? 'warn' : 'ok'
    );
  } catch (err) {
    payNote(err.message, 'error');
  }
  await loadPayments();
});

function payNote(text, tone = '') {
  const el = $('#payNote');
  el.textContent = text;
  el.dataset.tone = tone;
  el.hidden = !text;
}

/* ---------------- Intake ---------------- */

function askPdfMode({ name, pages }) {
  return new Promise((resolve) => {
    const d = $('#pdfMode');
    $('#pdfModeText').textContent = `“${name}” has ${pages} pages. Your answer applies to every PDF in this upload.`;
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue || 'cancel'), { once: true });
    d.showModal();
  });
}

function intakeNote(text, tone = '') {
  const el = $('#intakeNote');
  el.textContent = text;
  el.dataset.tone = tone;
  el.hidden = !text;
}

async function addFiles(files) {
  if (!files.length) return;
  let result;
  try {
    result = await expandUpload(files, { askPdfMode, onStatus: (t) => intakeNote(t) });
  } catch (err) {
    intakeNote(err.message, 'error');
    return;
  }
  const { sources, skipped } = result;
  // Jump to the new upload unless you are still working on an unfinished bill.
  const cur = current();
  if (sources.length && (!cur || ['done', 'skipped'].includes(cur.status))) state.selectedId = null;
  for (const src of sources) {
    const item = {
      id: uid(),
      source: src,
      name: src.name,
      status: 'queued',
      attempts: 0,
      previewUrl: src.type === 'image' ? URL.createObjectURL(src.file) : null,
    };
    state.items.push(item);
    if (!state.selectedId) state.selectedId = item.id;
  }
  const parts = [];
  if (sources.length > 1) parts.push(`${sources.length} bills added. They are read ${MAX_PARALLEL} at a time.`);
  if (skipped.length) parts.push(`Skipped: ${skipped.join(', ')}.`);
  intakeNote(parts.join(' '), skipped.length ? 'warn' : '');
  renderQueue();
  renderReview();
  pump();
}

function pump() {
  clearTimeout(state.wake);
  if (!state.paused) {
    while (state.running < MAX_PARALLEL) {
      const now = Date.now();
      const next = state.items.find((i) => i.status === 'queued' && !(i.notBefore > now));
      if (!next) break;
      state.running++;
      extract(next).finally(() => { state.running--; pump(); });
    }
    // Wake up again for bills that are waiting out a rate limit.
    const waits = state.items.filter((i) => i.status === 'queued' && i.notBefore > Date.now()).map((i) => i.notBefore);
    if (waits.length) state.wake = setTimeout(pump, Math.max(1000, Math.min(...waits) - Date.now()));
  }
  renderBatch();
}

const RETRYABLE = new Set([undefined, 0, 429, 502, 503, 504]);

async function extract(item) {
  item.status = 'reading';
  item.error = '';
  item.notBefore = 0;
  renderQueue();
  if (item.id === state.selectedId) renderReview();
  try {
    if (!item.prepared) {
      item.prepared = await prepareSource(item.source);
      if (item.prepared.previewUrl) item.previewUrl = item.prepared.previewUrl;
    }
    const p = item.prepared;
    if (p.ai.blob.size > 4 * 1024 * 1024) throw Object.assign(new Error('Image is larger than 4 MB. Scan at a lower resolution.'), { status: 413 });
    const res = await api.extract(p.ai.blob, p.ai.name);
    const b = res.bill;
    b.payment = b.payment || { status: 'unknown', method: '', amount: 0, reference: '' };
    if (p.note) b.warnings.unshift(p.note);
    item.bill = {
      ...b,
      partnerId: res.partner?.id || null,
      partnerName: res.partner?.name || '',
      journalId: defaultJournal(b.kind),
      entryLines: [],
      payment: {
        paid: b.kind === 'payment' || b.payment.status === 'paid' || b.payment.status === 'partial',
        status: b.payment.status,
        method: b.payment.method,
        reference: b.payment.reference,
        journalId: defaultPaymentJournal(b.payment.method),
        date: b.date || today(),
        amount: b.payment.amount || b.total,
        direction: 'outbound',
        linkedBillId: null,
      },
    };
    if (b.kind === 'payment' && !b.ref && b.payment.reference) item.bill.ref = b.payment.reference;
    item.partnerOptions = res.partnerOptions || [];
    item.historyId = res.historyId;
    item.duplicateOf = res.duplicateOf;
    item.model = res.model;
    if (b.documentType === 'other' && !b.total && !b.lines.length) {
      item.status = 'skipped';
      item.error = 'This page does not look like a bill (blank or cover page). It will not be sent.';
    } else {
      item.status = 'review';
      if (settings.auto && readyToSend(item)) await send(item, false, { quiet: true });
    }
  } catch (err) {
    if (err.status === 429 && err.details?.daily) {
      item.status = 'queued';
      state.paused = true;
      state.pauseMsg = err.message;
    } else if (RETRYABLE.has(err.status) && item.attempts < MAX_ATTEMPTS - 1) {
      item.attempts++;
      item.status = 'queued';
      item.notBefore = Date.now() + 20_000 * item.attempts; // 20 s, 40 s, 60 s
      item.error = `${err.message} Retrying automatically (${item.attempts}/${MAX_ATTEMPTS - 1})…`;
    } else {
      item.status = 'failed';
      item.error = err.message;
    }
  }
  renderQueue();
  if (item.id === state.selectedId) renderReview();
}

// Has everything Odoo needs to accept the draft.
function canSend(item) {
  const b = item.bill;
  if (!b || item.dupUrl) return false;
  if (b.kind === 'payment') {
    const vendorOk = b.payment.linkedBillId || b.partnerId || (b.vendor.name && state.health?.autoCreatePartner);
    return Boolean(vendorOk && Number(b.payment.amount) > 0 && b.payment.journalId);
  }
  if (b.kind === 'bill' && b.payment?.paid && !b.payment.journalId) return false;
  if (b.kind === 'entry') {
    const j = journalRows(b, state.catalog);
    return b.entryLines.length > 0 && b.entryLines.every((l) => l.accountId) && j.balanced;
  }
  const vendorOk = b.partnerId || (b.vendor.name && state.health?.autoCreatePartner);
  return Boolean(vendorOk && b.lines.length && b.lines.every((l) => l.accountId));
}

async function createAll() {
  if (state.bulk) return;
  state.bulk = true;
  renderBatch();
  let made = 0, needs = 0, failed = 0;
  for (const item of state.items.filter((i) => i.status === 'review')) {
    if (!canSend(item)) { needs++; continue; }
    await send(item, false, { quiet: true });
    if (item.status === 'done') made++; else failed++;
  }
  state.bulk = false;
  const parts = [`${made} draft${made === 1 ? '' : 's'} created in Odoo.`];
  if (needs) parts.push(`${needs} need a vendor or an account first — open them from the list.`);
  if (failed) parts.push(`${failed} could not be sent — open them to see why.`);
  intakeNote(parts.join(' '), needs || failed ? 'warn' : 'ok');
  renderBatch();
}

function renderBatch() {
  const el = $('#batch');
  const c = { queued: 0, reading: 0, review: 0, ready: 0, done: 0, failed: 0, skipped: 0, sending: 0 };
  for (const i of state.items) {
    c[i.status] = (c[i.status] || 0) + 1;
    if (i.status === 'review' && canSend(i)) c.ready++;
  }
  const total = state.items.length;
  el.hidden = total < 2 && !state.paused;
  if (el.hidden) return;
  const read = total - c.queued - c.reading;
  const pct = total ? Math.round((read / total) * 100) : 0;
  el.innerHTML = `
    <div class="batch-line"><strong>${read} of ${total} read</strong><span>${c.done} created · ${c.review} to check${c.failed ? ` · ${c.failed} failed` : ''}${c.skipped ? ` · ${c.skipped} not bills` : ''}</span></div>
    <div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>
    ${state.paused ? `<p class="batch-pause">${esc(state.pauseMsg)}</p>` : ''}
    <div class="batch-actions">
      <button class="btn primary" id="createAll" ${c.ready && !state.bulk ? '' : 'disabled'}>${state.bulk ? 'Creating drafts…' : c.ready ? `Create ${c.ready} draft${c.ready === 1 ? '' : 's'}` : c.review ? 'Check the bills first' : 'All sent'}</button>
      ${state.paused ? '<button class="btn" id="resumeBtn">Resume</button>' : ''}
      ${c.failed ? '<button class="btn" id="retryFailed">Retry failed</button>' : ''}
      ${c.done || c.skipped ? '<button class="btn ghost" id="clearDone">Clear finished</button>' : ''}
    </div>`;
  $('#createAll').onclick = createAll;
  if ($('#resumeBtn')) $('#resumeBtn').onclick = () => { state.paused = false; state.pauseMsg = ''; pump(); };
  if ($('#retryFailed')) $('#retryFailed').onclick = () => {
    for (const i of state.items) if (i.status === 'failed') Object.assign(i, { status: 'queued', attempts: 0, notBefore: 0, error: '' });
    renderQueue();
    pump();
  };
  if ($('#clearDone')) $('#clearDone').onclick = () => {
    state.items = state.items.filter((i) => i.status !== 'done' && i.status !== 'skipped');
    if (!state.items.some((i) => i.id === state.selectedId)) state.selectedId = state.items[0]?.id || null;
    renderQueue();
    if (state.selectedId) renderReview();
    else $('#review').innerHTML = '<div class="empty"><h2>All done</h2><p>Every bill in this batch was handled. Add more on the left.</p></div>';
  };
}

// Auto-create only when there is nothing a human should look at.
function readyToSend(item) {
  const b = item.bill;
  if (b.kind === 'payment') return !b.payment.linkedBillId && canSend(item) && b.confidence >= 0.75 && !item.duplicateOf;
  const vendorOk = b.partnerId || (b.vendor.name && state.health?.autoCreatePartner);
  const linesOk = b.lines.length && b.lines.every((l) => l.accountId);
  const blocking = b.warnings.some((w) => !w.startsWith('Prices on the document include VAT'));
  return vendorOk && linesOk && !blocking && !item.duplicateOf && b.confidence >= 0.75;
}

$('#fileInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
$('#cameraInput').addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });

const drop = $('#drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) addFiles(files);
});

/* ---------------- Queue ---------------- */

const STATUS_TEXT = { queued: 'In line', reading: 'Reading…', review: 'Check and send', sending: 'Sending…', done: 'Draft created', failed: 'Needs attention', skipped: 'Not a bill' };
function statusOf(i) {
  if (i.status === 'queued' && state.paused) return ['waiting', 'Paused'];
  if (i.status === 'queued' && i.notBefore > Date.now()) return ['waiting', 'Retrying soon'];
  if (i.status === 'review' && canSend(i)) return ['ready', 'Ready'];
  return [i.status, STATUS_TEXT[i.status]];
}

function renderQueue() {
  $('#queue').innerHTML = state.items.map((i) => {
    const title = i.bill?.vendor?.name || i.name;
    const amount = i.bill ? `${money(i.bill.total)} ${esc(i.bill.currency)}` : '';
    return `<li>
      <button class="q-item" data-id="${i.id}" ${i.id === state.selectedId ? 'aria-current="true"' : ''}>
        ${i.previewUrl ? `<img src="${i.previewUrl}" alt="">` : '<span class="q-pdf">PDF</span>'}
        <span class="q-text"><span class="q-title">${esc(title)}</span><span class="q-meta">${amount}</span></span>
        <span class="chip" data-status="${statusOf(i)[0]}">${statusOf(i)[1]}</span>
      </button>
    </li>`;
  }).join('');
  renderBatch();
}

$('#queue').addEventListener('click', (e) => {
  const btn = e.target.closest('.q-item');
  if (!btn) return;
  state.selectedId = btn.dataset.id;
  renderQueue();
  renderReview();
  if (window.matchMedia('(max-width: 900px)').matches) $('#review').scrollIntoView({ behavior: 'smooth' });
});

/* ---------------- Review ---------------- */

function accountOptions(selected, all) {
  const list = all ? (state.catalog.allAccounts || state.catalog.accounts) : state.catalog.accounts;
  return `<option value="">Choose account</option>` + list.map((a) =>
    `<option value="${a.id}" ${Number(selected) === a.id ? 'selected' : ''}>${esc(a.code)} ${esc(a.name)}</option>`).join('');
}

function taxOptions(selectedIds = []) {
  const sel = Number(selectedIds[0]) || 0;
  return `<option value="">No tax</option>` + state.catalog.taxes.map((t) =>
    `<option value="${t.id}" ${sel === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
}

function currencyOptions(code) {
  const list = state.catalog.currencies;
  const has = list.some((c) => c.code === code);
  return (has || !code ? '' : `<option value="${esc(code)}" selected>${esc(code)} (not active in Odoo)</option>`) +
    list.map((c) => `<option value="${esc(c.code)}" ${c.code === code ? 'selected' : ''}>${esc(c.code)}</option>`).join('');
}

function sendLabel(b) {
  if (b.kind === 'payment') return b.payment.linkedBillId ? 'Register payment in Odoo' : 'Create draft payment';
  return 'Create draft in Odoo';
}

function doneText(r) {
  if (r.kind === 'registered') return `Payment registered on ${r.name}${r.state === 'partial' ? ' (partially paid).' : ' — it is now paid.'}`;
  if (r.kind === 'payment') return `${r.name} created in Odoo as a draft payment. Check it and confirm it there.`;
  return `${r.name || 'Draft'} created in Odoo. Check it and post it there.${r.plannedPayment ? ' Then register its payment from the Payments tab.' : ''}`;
}

function linkedBillOptions(item) {
  const bills = item.openBills || [];
  const sel = item.bill.payment.linkedBillId;
  if (item.bill.partnerId && !item.openBills) loadOpenBillsFor(item);
  return '<option value="">No — create a draft payment</option>' + bills.map((o) =>
    `<option value="${o.id}" ${Number(sel) === o.id ? 'selected' : ''}>${esc(o.name)}${o.ref ? ` · ${esc(o.ref)}` : ''} · open ${money(o.residual)} ${esc(o.currency)}</option>`).join('');
}

async function loadOpenBillsFor(item) {
  if (item.loadingBills) return;
  item.loadingBills = true;
  try {
    item.openBills = await api.openBills('', item.bill.partnerId);
    // Pre-select the bill whose reference matches the memo on the payment.
    const ref = (item.bill.ref || '').trim().toLowerCase();
    const match = ref && item.openBills.find((o) => o.ref.toLowerCase() === ref || o.name.toLowerCase() === ref);
    if (match && !item.bill.payment.linkedBillId) item.bill.payment.linkedBillId = match.id;
  } catch { item.openBills = []; }
  item.loadingBills = false;
  if (item.id === state.selectedId && item.bill.kind === 'payment') renderReview();
}

function paidBox(b) {
  const p = b.payment;
  const hint = p.status === 'paid' || p.status === 'partial'
    ? `The document looks ${p.status === 'partial' ? 'partly paid' : 'paid'}${p.method ? ` by ${METHOD_TEXT[p.method]}` : ''}${p.reference ? ` (ref ${esc(p.reference)})` : ''}.`
    : p.status === 'unpaid' ? 'The document looks unpaid (on credit).' : '';
  return `<fieldset class="paybox">
    <legend>Payment</legend>
    <div class="kind small-kind">
      <label><input type="radio" name="paid" value="no" ${p.paid ? '' : 'checked'}> Not paid yet</label>
      <label><input type="radio" name="paid" value="yes" ${p.paid ? 'checked' : ''}> Already paid</label>
    </div>
    ${hint ? `<p class="hint">${hint}</p>` : ''}
    <div class="fields paybox-fields" ${p.paid ? '' : 'hidden'}>
      <div class="field"><label for="pJournal">Paid from</label><select id="pJournal">${paymentJournalOptions(p.journalId, { blank: true })}</select></div>
      <div class="field"><label for="pDate">Paid on</label><input id="pDate" type="date" value="${esc(p.date)}"></div>
      <div class="field"><label for="pAmount">Amount paid</label><input id="pAmount" class="num" type="number" step="0.01" min="0" value="${p.amount || ''}"></div>
    </div>
    ${p.paid ? '<p class="hint">Odoo only accepts payments on posted bills. After you post this draft, the Payments tab has it ticked and ready — one click registers the payment and marks the bill paid.</p>' : ''}
  </fieldset>`;
}

function renderReview() {
  const el = $('#review');
  const item = current();
  if (!item || !state.catalog) {
    if (!state.catalog && item) el.innerHTML = '<div class="empty"><h2>Waiting for Odoo</h2><p>Accounts and taxes load from Odoo first. Check the connection in the top bar.</p></div>';
    return;
  }
  if (item.status === 'reading') {
    el.innerHTML = `<div class="empty"><div class="scanline" aria-hidden="true"></div><h2>Reading ${esc(item.name)}</h2><p>Finding the vendor, lines, VAT and totals. The free AI can take a minute or two per bill — you can keep working on other bills meanwhile.</p></div>`;
    return;
  }
  if (item.status === 'queued') {
    el.innerHTML = `<div class="empty"><h2>${esc(item.name)} is in line</h2><p>${item.error ? esc(item.error) : state.paused ? esc(state.pauseMsg) : 'It will be read as soon as a slot frees up.'}</p></div>`;
    return;
  }
  if (item.status === 'failed' && !item.bill) {
    el.innerHTML = `<div class="empty"><h2>Couldn't read this bill</h2><p class="form-error">${esc(item.error)}</p><button class="btn primary" id="retry">Try again</button></div>`;
    $('#retry').onclick = () => { item.status = 'queued'; renderQueue(); pump(); };
    return;
  }

  const b = item.bill;
  const done = item.status === 'done';
  const isPay = b.kind === 'payment';
  el.innerHTML = `
    <div class="review-head">
      ${item.previewUrl ? `<button class="thumb" id="zoomBtn" aria-label="Enlarge scan"><img src="${item.previewUrl}" alt="Scanned bill"></button>` : '<div class="thumb q-pdf">PDF</div>'}
      <div>
        <h2>${esc(b.vendor.name || 'Unknown vendor')}</h2>
        ${b.vendor.nameOriginal ? `<p class="arabic" dir="rtl" lang="ar">${esc(b.vendor.nameOriginal)}</p>` : ''}
        <p class="muted">${b.documentType === 'receipt' ? 'Receipt' : b.documentType === 'refund' ? 'Credit note' : 'Invoice'} · read in ${b.language === 'ar' ? 'Arabic' : b.language === 'mixed' ? 'Arabic and English' : b.language === 'fr' ? 'French' : 'English'} · confidence ${Math.round((b.confidence || 0) * 100)}%</p>
      </div>
    </div>

    ${done ? `<div class="notice ok"><strong>${esc(doneText(item.result))}</strong> <a href="${esc(item.result.url)}" target="_blank" rel="noopener">Open in Odoo</a>${item.result.warnings?.length ? `<ul>${item.result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    ${item.error ? `<div class="notice error">${esc(item.error)}${item.dupUrl ? ` <a href="${esc(item.dupUrl)}" target="_blank" rel="noopener">Open existing</a> <button class="btn small" id="forceBtn">Create anyway</button>` : ''}</div>` : ''}
    ${b.warnings.length && !done ? `<ul class="notice warn">${b.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${b.notes && !done ? `<p class="notes">${esc(b.notes)}</p>` : ''}

    <fieldset class="kind" ${done ? 'disabled' : ''}>
      <legend>Record as</legend>
      ${[['bill', 'Vendor bill'], ['refund', 'Vendor refund'], ['payment', 'Vendor payment'], ['entry', 'Journal entry']].map(([v, t]) =>
        `<label><input type="radio" name="kind" value="${v}" ${b.kind === v ? 'checked' : ''}> ${t}</label>`).join('')}
    </fieldset>

    <fieldset class="fields" ${done ? 'disabled' : ''}>
      <div class="field vendor-field">
        <label for="fVendor">Vendor</label>
        <input id="fVendor" value="${esc(b.partnerName || b.vendor.name)}" autocomplete="off">
        <p class="hint" id="vendorHint">${b.partnerId ? 'Linked to the Odoo contact.' : state.health?.autoCreatePartner ? 'No Odoo contact matched. A new vendor will be created.' : 'Pick a vendor from Odoo.'}</p>
        <ul class="suggest" id="vendorSuggest" hidden></ul>
      </div>
      <div class="field"><label for="fRef">${isPay ? 'Memo (bill it pays)' : 'Bill reference'}</label><input id="fRef" value="${esc(b.ref)}"></div>
      <div class="field"><label for="fDate">${isPay ? 'Payment date' : 'Bill date'}</label><input id="fDate" type="date" value="${esc(b.date)}"></div>
      <div class="field" ${b.kind === 'entry' || isPay ? 'hidden' : ''}><label for="fDue">Due date</label><input id="fDue" type="date" value="${esc(b.dueDate)}"></div>
      <div class="field"><label for="fCur">Currency</label><select id="fCur">${currencyOptions(b.currency)}</select></div>
      ${isPay ? `
      <div class="field"><label for="fPayJournal">Paid from</label><select id="fPayJournal">${paymentJournalOptions(b.payment.journalId, { blank: true })}</select></div>
      <div class="field"><label for="fPayAmount">Amount</label><input id="fPayAmount" class="num" type="number" step="0.01" min="0" value="${b.payment.amount || ''}"></div>
      <div class="field"><label for="fPayDir">Direction</label><select id="fPayDir">
        <option value="outbound" ${b.payment.direction !== 'inbound' ? 'selected' : ''}>We paid the vendor</option>
        <option value="inbound" ${b.payment.direction === 'inbound' ? 'selected' : ''}>Vendor refunded us</option></select></div>
      <div class="field wide"><label for="fPayBill">Apply to an open bill (optional)</label>
        <select id="fPayBill" ${b.partnerId ? '' : 'disabled'}>${linkedBillOptions(item)}</select>
        <p class="hint">${b.partnerId ? 'Choose a posted bill to register this payment on it — the bill is marked paid right away. Leave empty for a draft payment.' : 'Link the vendor to an Odoo contact to see their open bills.'}</p></div>`
      : `<div class="field"><label for="fJournal">Journal</label><select id="fJournal">${journalOptions(b.kind === 'entry' ? 'general' : 'purchase', b.journalId)}</select></div>`}
    </fieldset>

    <div class="lines-wrap" ${isPay ? 'hidden' : ''}><div id="lines"></div></div>

    ${b.kind === 'bill' ? paidBox(b) : ''}

    <section class="ledger" aria-label="Debit and credit preview">
      <h3>How it will post</h3>
      <div id="ledger"></div>
    </section>

    ${done ? '' : `<div class="actions">
      <button class="btn primary big" id="sendBtn" ${item.status === 'sending' ? 'disabled' : ''}>${item.status === 'sending' ? 'Sending to Odoo…' : sendLabel(b)}</button>
      <button class="btn ghost" id="removeBtn">Remove from batch</button>
    </div>`}
    <p class="muted small">Read by ${esc(item.model || 'AI')}. ${isPay && b.payment.linkedBillId ? 'This registers the payment on a posted bill in Odoo, with the scan attached.' : 'Nothing is posted — Odoo receives a draft with the scan attached.'}</p>
  `;

  renderLines();
  renderLedger();
  bindReview(item);
}

function renderLines() {
  const item = current();
  const b = item.bill;
  const done = item.status === 'done';
  const box = $('#lines');
  if (b.kind === 'entry') {
    box.innerHTML = `<table class="grid lines"><thead><tr><th>Label</th><th>Account</th><th class="num">Debit</th><th class="num">Credit</th><th></th></tr></thead><tbody>
      ${b.entryLines.map((l, i) => `<tr data-i="${i}">
        <td data-label="Label"><input data-f="description" value="${esc(l.description)}" ${done ? 'disabled' : ''} aria-label="Label"></td>
        <td data-label="Account"><select data-f="accountId" ${done ? 'disabled' : ''} aria-label="Account">${accountOptions(l.accountId, true)}</select></td>
        <td data-label="Debit"><input data-f="debit" class="num debit" type="number" step="0.01" min="0" value="${l.debit || ''}" ${done ? 'disabled' : ''} aria-label="Debit"></td>
        <td data-label="Credit"><input data-f="credit" class="num credit" type="number" step="0.01" min="0" value="${l.credit || ''}" ${done ? 'disabled' : ''} aria-label="Credit"></td>
        <td>${done ? '' : `<button class="icon" data-del="${i}" aria-label="Remove line">×</button>`}</td>
      </tr>`).join('')}
    </tbody></table>${done ? '' : '<button class="btn small" id="addLine">Add line</button>'}`;
  } else {
    const t = billTotals(b.lines, state.catalog);
    box.innerHTML = `<table class="grid lines"><thead><tr><th>Description</th><th>Account</th><th class="num">Qty</th><th class="num">Price</th><th>Tax</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${b.lines.map((l, i) => `<tr data-i="${i}">
        <td data-label="Description"><input data-f="description" value="${esc(l.description)}" ${done ? 'disabled' : ''} aria-label="Description"></td>
        <td data-label="Account"><select data-f="accountId" ${done ? 'disabled' : ''} aria-label="Account" title="${esc(l.accountReason || '')}">${accountOptions(l.accountId)}</select></td>
        <td data-label="Qty"><input data-f="quantity" class="num" type="number" step="any" value="${l.quantity}" ${done ? 'disabled' : ''} aria-label="Quantity"></td>
        <td data-label="Price"><input data-f="unitPrice" class="num" type="number" step="0.01" value="${l.unitPrice}" ${done ? 'disabled' : ''} aria-label="Unit price"></td>
        <td data-label="Tax"><select data-f="taxIds" ${done ? 'disabled' : ''} aria-label="Tax">${taxOptions(l.taxIds)}</select></td>
        <td class="num" data-label="Amount" data-sub="${i}">${money(lineSubtotal(l))}</td>
        <td>${done ? '' : `<button class="icon" data-del="${i}" aria-label="Remove line">×</button>`}</td>
      </tr>`).join('')}
    </tbody></table>
    <div class="totals" id="totals">
      <span>Untaxed <b>${money(t.untaxed)}</b></span><span>Tax <b>${money(t.tax)}</b></span><span>Total <b>${money(t.total)} ${esc(b.currency)}</b></span>
      ${b.total && Math.abs(b.total - t.total) > 0.05 ? `<span class="mismatch">Document says ${money(b.total)}</span>` : ''}
    </div>
    ${done ? '' : '<button class="btn small" id="addLine">Add line</button>'}`;
  }
}

function ledgerTable(j, caption = '') {
  return `${caption ? `<p class="ledger-caption">${caption}</p>` : ''}<table class="t-account">
    <thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
    <tbody>${j.rows.map((r) => `<tr class="${r.missing ? 'missing' : ''}">
      <td>${r.code ? `<span class="acc-code">${esc(r.code)}</span>` : ''}${esc(r.name)}<span class="memo">${esc(r.memo || '')}</span></td>
      <td class="num dr">${r.debit ? money(r.debit) : ''}</td>
      <td class="num cr">${r.credit ? money(r.credit) : ''}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>${j.balanced ? 'Balanced' : 'Not balanced'}</td><td class="num dr">${money(j.debit)}</td><td class="num cr">${money(j.credit)}</td></tr></tfoot>
  </table>`;
}

function renderLedger() {
  const item = current();
  const b = item.bill;
  const j = journalRows(b, state.catalog);
  let html = ledgerTable(j, b.kind === 'payment' ? 'The payment' : '');
  if (b.kind === 'bill' && b.payment?.paid) {
    html = ledgerTable(j, 'The bill') + ledgerTable(paymentRows(b, state.catalog), 'The payment — registered after you post the bill');
  }
  $('#ledger').innerHTML = html;
  $('#ledger').dataset.balanced = j.balanced;
}

function refreshTotals() {
  const item = current();
  if (item.bill.kind !== 'entry') {
    item.bill.lines.forEach((l, i) => { const c = document.querySelector(`[data-sub="${i}"]`); if (c) c.textContent = money(lineSubtotal(l)); });
    const t = billTotals(item.bill.lines, state.catalog);
    const box = $('#totals');
    if (box) box.innerHTML = `<span>Untaxed <b>${money(t.untaxed)}</b></span><span>Tax <b>${money(t.tax)}</b></span><span>Total <b>${money(t.total)} ${esc(item.bill.currency)}</b></span>` +
      (item.bill.total && Math.abs(item.bill.total - t.total) > 0.05 ? `<span class="mismatch">Document says ${money(item.bill.total)}</span>` : '');
  }
  renderLedger();
}

let vendorTimer;
function bindReview(item) {
  const b = item.bill;
  const el = $('#review');

  $('#zoomBtn')?.addEventListener('click', () => { $('#zoomBody').innerHTML = `<img src="${item.previewUrl}" alt="Scanned bill">`; $('#zoom').showModal(); });

  el.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener('change', () => {
    const prevKind = b.kind;
    b.kind = r.value;
    if (b.kind === 'entry' && !b.entryLines.length) b.entryLines = billToEntryLines({ ...b, kind: prevKind }, state.catalog);
    if (b.kind === 'payment') {
      b.payment.paid = true;
      if (!(b.payment.amount > 0)) b.payment.amount = b.total || billTotals(b.lines, state.catalog).total;
      if (!b.payment.journalId) b.payment.journalId = defaultPaymentJournal(b.payment.method);
    }
    if (prevKind === 'payment' && b.kind === 'bill') b.payment.paid = b.payment.status === 'paid' || b.payment.status === 'partial';
    b.journalId = defaultJournal(b.kind);
    renderReview();
  }));

  const bindField = (sel, key, ev = 'input') => $(sel)?.addEventListener(ev, (e) => { b[key] = e.target.value; renderLedger(); });
  bindField('#fRef', 'ref');
  bindField('#fDate', 'date');
  bindField('#fDue', 'dueDate');
  bindField('#fCur', 'currency', 'change');
  bindField('#fJournal', 'journalId', 'change');

  // Payment fields (vendor payment record, or "already paid" on a bill)
  const bindPay = (sel, key, ev = 'input', cast = (v) => v) => $(sel)?.addEventListener(ev, (e) => { b.payment[key] = cast(e.target.value); renderLedger(); renderQueue(); });
  bindPay('#fPayJournal', 'journalId', 'change', Number);
  bindPay('#fPayAmount', 'amount', 'input', (v) => parseFloat(v) || 0);
  bindPay('#fPayDir', 'direction', 'change');
  bindPay('#pJournal', 'journalId', 'change', Number);
  bindPay('#pDate', 'date');
  bindPay('#pAmount', 'amount', 'input', (v) => parseFloat(v) || 0);
  $('#fPayBill')?.addEventListener('change', (e) => {
    b.payment.linkedBillId = e.target.value ? Number(e.target.value) : null;
    const o = (item.openBills || []).find((x) => x.id === b.payment.linkedBillId);
    if (o && !(b.payment.amount > 0)) b.payment.amount = o.residual;
    renderReview();
  });
  el.querySelectorAll('input[name="paid"]').forEach((r) => r.addEventListener('change', () => {
    b.payment.paid = r.value === 'yes';
    if (b.payment.paid && !(b.payment.amount > 0)) b.payment.amount = billTotals(b.lines, state.catalog).total;
    if (b.payment.paid && !b.payment.journalId) b.payment.journalId = defaultPaymentJournal(b.payment.method);
    renderReview();
  }));

  // Vendor search against Odoo contacts
  const vInput = $('#fVendor');
  const list = $('#vendorSuggest');
  const showSuggestions = (options) => {
    list.innerHTML = options.map((p) => `<li><button type="button" data-id="${p.id}" data-name="${esc(p.name)}">${esc(p.name)}${p.vat ? ` <span class="muted">${esc(p.vat)}</span>` : ''}</button></li>`).join('') +
      `<li><button type="button" data-new="1">Create “${esc(vInput.value)}” as a new vendor</button></li>`;
    list.hidden = false;
  };
  vInput?.addEventListener('focus', () => { if (!item.status.match(/done/)) showSuggestions(item.partnerOptions || []); });
  vInput?.addEventListener('input', () => {
    b.partnerId = null;
    b.partnerName = '';
    b.vendor.name = vInput.value;
    $('#vendorHint').textContent = 'Not linked yet — pick a match or create a new vendor.';
    clearTimeout(vendorTimer);
    vendorTimer = setTimeout(async () => {
      if (vInput.value.trim().length < 2) return;
      item.partnerOptions = await api.partners(vInput.value).catch(() => []);
      if (document.activeElement === vInput) showSuggestions(item.partnerOptions);
    }, 250);
    renderLedger();
  });
  list?.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.new) {
      b.partnerId = null;
      $('#vendorHint').textContent = 'A new vendor will be created in Odoo.';
    } else {
      b.partnerId = Number(btn.dataset.id);
      b.partnerName = btn.dataset.name;
      vInput.value = btn.dataset.name;
      $('#vendorHint').textContent = 'Linked to the Odoo contact.';
    }
    list.hidden = true;
    // Payments: the "apply to an open bill" list depends on the vendor.
    item.openBills = null;
    b.payment.linkedBillId = null;
    if (b.kind === 'payment') renderReview(); else renderLedger();
  });
  vInput?.addEventListener('blur', () => setTimeout(() => { if (list) list.hidden = true; }, 200));

  // Line editing
  const linesBox = $('#lines');
  const target = () => (b.kind === 'entry' ? b.entryLines : b.lines);
  linesBox.addEventListener('input', (e) => {
    const row = e.target.closest('tr[data-i]');
    if (!row) return;
    const line = target()[Number(row.dataset.i)];
    const f = e.target.dataset.f;
    if (f === 'taxIds') line.taxIds = e.target.value ? [Number(e.target.value)] : [];
    else if (f === 'accountId') line.accountId = e.target.value ? Number(e.target.value) : null;
    else if (f === 'description') line.description = e.target.value;
    else {
      line[f] = parseFloat(e.target.value) || 0;
      // A journal line is either debit or credit.
      if (f === 'debit' && line.debit) { line.credit = 0; row.querySelector('[data-f="credit"]').value = ''; }
      if (f === 'credit' && line.credit) { line.debit = 0; row.querySelector('[data-f="debit"]').value = ''; }
    }
    refreshTotals();
  });
  linesBox.addEventListener('click', (e) => {
    if (e.target.dataset.del !== undefined) { target().splice(Number(e.target.dataset.del), 1); renderLines(); refreshTotals(); }
    if (e.target.id === 'addLine') {
      const last = target()[target().length - 1];
      target().push(b.kind === 'entry'
        ? { description: '', accountId: null, debit: 0, credit: 0 }
        : { description: '', quantity: 1, unitPrice: 0, taxIds: last?.taxIds || [], accountId: last?.accountId || null });
      renderLines();
      refreshTotals();
    }
  });

  $('#sendBtn')?.addEventListener('click', () => send(item));
  $('#forceBtn')?.addEventListener('click', () => send(item, true));
  $('#removeBtn')?.addEventListener('click', () => {
    state.items = state.items.filter((i) => i !== item);
    state.selectedId = state.items[0]?.id || null;
    renderQueue();
    if (state.selectedId) renderReview();
    else $('#review').innerHTML = '<div class="empty"><h2>Batch is empty</h2><p>Add another bill on the left.</p></div>';
  });
}

async function send(item, allowDuplicate = false, { quiet = false } = {}) {
  const b = item.bill;
  item.status = 'sending';
  item.error = '';
  item.dupUrl = '';
  renderQueue();
  if (item.id === state.selectedId) renderReview();
  try {
    item.result = await api.createDraft({
      historyId: item.historyId,
      kind: b.kind,
      partnerId: b.partnerId,
      vendor: b.vendor,
      ref: b.ref,
      date: b.date,
      dueDate: b.dueDate,
      currency: b.currency,
      journalId: b.journalId,
      lines: b.kind === 'entry' ? b.entryLines : b.lines,
      payment: b.kind === 'payment' || (b.kind === 'bill' && b.payment?.paid) ? b.payment : undefined,
      file: item.prepared ? { name: item.prepared.attach.name, mimeType: item.prepared.attach.mimeType, base64: await toBase64(item.prepared.attach.blob) } : null,
      allowDuplicate,
    });
    item.status = 'done';
    const next = state.items.find((i) => i.status === 'review' && i !== item);
    if (next && !settings.auto && !quiet) setTimeout(() => { state.selectedId = next.id; renderQueue(); renderReview(); }, 1800);
  } catch (err) {
    item.status = 'review';
    item.error = err.message;
    if (err.status === 409) item.dupUrl = err.details?.url || '';
  }
  renderQueue();
  if (item.id === state.selectedId) renderReview();
}

boot();
