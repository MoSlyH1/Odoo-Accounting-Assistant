import { api, auth } from './api.js';
import { prepareFile, toBase64 } from './image.js';
import { journalRows, billTotals, lineSubtotal, billToEntryLines, money } from './ledger.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const MAX_PARALLEL = 2; // stay inside free-tier AI rate limits

const SETTINGS_KEY = 'billAgent.settings';
const settings = Object.assign({ billJournal: '', entryJournal: '', auto: false }, (() => {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
})());
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ } };

const state = { items: [], selectedId: null, catalog: null, health: null, running: 0 };
const current = () => state.items.find((i) => i.id === state.selectedId);

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

function fillSettings() {
  $('#setBillJournal').innerHTML = journalOptions('purchase', settings.billJournal || defaultJournal('bill'));
  $('#setEntryJournal').innerHTML = journalOptions('general', settings.entryJournal || defaultJournal('entry'));
  $('#setAuto').checked = settings.auto;
}

$('#settingsBtn').addEventListener('click', () => $('#settings').showModal());
$('#setBillJournal').addEventListener('change', (e) => { settings.billJournal = e.target.value; saveSettings(); });
$('#setEntryJournal').addEventListener('change', (e) => { settings.entryJournal = e.target.value; saveSettings(); });
$('#setAuto').addEventListener('change', (e) => { settings.auto = e.target.checked; saveSettings(); });
$('#refreshCatalog').addEventListener('click', async (e) => { e.target.disabled = true; await loadCatalog(true); e.target.disabled = false; });
$('#logoutBtn').addEventListener('click', () => { auth.token = null; $('#settings').close(); showLogin(); });

/* ---------------- Tabs ---------------- */

document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.removeAttribute('aria-current'));
  t.setAttribute('aria-current', 'page');
  const view = t.dataset.view;
  $('#view-scan').hidden = view !== 'scan';
  $('#view-history').hidden = view !== 'history';
  if (view === 'history') loadHistory();
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

/* ---------------- Intake ---------------- */

function addFiles(files) {
  for (const file of files) {
    const item = { id: uid(), file, name: file.name, status: 'queued', previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : null };
    state.items.unshift(item);
    if (!state.selectedId) state.selectedId = item.id;
  }
  renderQueue();
  pump();
}

function pump() {
  while (state.running < MAX_PARALLEL) {
    const next = [...state.items].reverse().find((i) => i.status === 'queued');
    if (!next) return;
    state.running++;
    extract(next).finally(() => { state.running--; pump(); });
  }
}

async function extract(item) {
  item.status = 'reading';
  item.error = '';
  renderQueue();
  if (item.id === state.selectedId) renderReview();
  try {
    const prepared = await prepareFile(item.file);
    if (prepared.previewUrl) item.previewUrl = prepared.previewUrl; // PDF page shown as thumbnail
    if (prepared.ai.blob.size > 4 * 1024 * 1024) throw new Error('Image is larger than 4 MB. Scan at a lower resolution or take a photo instead.');
    // Odoo gets the original file; fall back to the image if the PDF is too big to send.
    const attach = prepared.original.blob.size * 1.37 < 4 * 1024 * 1024 ? prepared.original : prepared.ai;
    item.upload = { name: attach.name, mimeType: attach.mimeType, base64: await toBase64(attach.blob) };
    const res = await api.extract(prepared.ai.blob, prepared.ai.name);
    const b = res.bill;
    if (prepared.note) b.warnings.unshift(prepared.note);
    item.bill = {
      ...b,
      partnerId: res.partner?.id || null,
      partnerName: res.partner?.name || '',
      journalId: defaultJournal(b.kind),
      entryLines: [],
    };
    item.partnerOptions = res.partnerOptions || [];
    item.historyId = res.historyId;
    item.duplicateOf = res.duplicateOf;
    item.model = res.model;
    item.status = 'review';
    if (settings.auto && readyToSend(item)) await send(item);
  } catch (err) {
    item.status = 'failed';
    item.error = err.message;
  }
  renderQueue();
  if (item.id === state.selectedId) renderReview();
}

// Auto-create only when there is nothing a human should look at.
function readyToSend(item) {
  const b = item.bill;
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

const STATUS_TEXT = { queued: 'Waiting', reading: 'Reading…', review: 'Check and send', sending: 'Sending…', done: 'Draft created', failed: 'Needs attention' };

function renderQueue() {
  $('#queue').innerHTML = state.items.map((i) => {
    const title = i.bill?.vendor?.name || i.name;
    const amount = i.bill ? `${money(i.bill.total)} ${esc(i.bill.currency)}` : '';
    return `<li>
      <button class="q-item" data-id="${i.id}" ${i.id === state.selectedId ? 'aria-current="true"' : ''}>
        ${i.previewUrl ? `<img src="${i.previewUrl}" alt="">` : '<span class="q-pdf">PDF</span>'}
        <span class="q-text"><span class="q-title">${esc(title)}</span><span class="q-meta">${amount}</span></span>
        <span class="chip" data-status="${i.status}">${STATUS_TEXT[i.status]}</span>
      </button>
    </li>`;
  }).join('');
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

function renderReview() {
  const el = $('#review');
  const item = current();
  if (!item || !state.catalog) {
    if (!state.catalog && item) el.innerHTML = '<div class="empty"><h2>Waiting for Odoo</h2><p>Accounts and taxes load from Odoo first. Check the connection in the top bar.</p></div>';
    return;
  }
  if (item.status === 'queued' || item.status === 'reading') {
    el.innerHTML = `<div class="empty"><div class="scanline" aria-hidden="true"></div><h2>Reading ${esc(item.name)}</h2><p>Finding the vendor, lines, VAT and totals.</p></div>`;
    return;
  }
  if (item.status === 'failed' && !item.bill) {
    el.innerHTML = `<div class="empty"><h2>Couldn't read this bill</h2><p class="form-error">${esc(item.error)}</p><button class="btn primary" id="retry">Try again</button></div>`;
    $('#retry').onclick = () => { item.status = 'queued'; renderQueue(); pump(); };
    return;
  }

  const b = item.bill;
  const done = item.status === 'done';
  el.innerHTML = `
    <div class="review-head">
      ${item.previewUrl ? `<button class="thumb" id="zoomBtn" aria-label="Enlarge scan"><img src="${item.previewUrl}" alt="Scanned bill"></button>` : '<div class="thumb q-pdf">PDF</div>'}
      <div>
        <h2>${esc(b.vendor.name || 'Unknown vendor')}</h2>
        ${b.vendor.nameOriginal ? `<p class="arabic" dir="rtl" lang="ar">${esc(b.vendor.nameOriginal)}</p>` : ''}
        <p class="muted">${b.documentType === 'receipt' ? 'Receipt' : b.documentType === 'refund' ? 'Credit note' : 'Invoice'} · read in ${b.language === 'ar' ? 'Arabic' : b.language === 'mixed' ? 'Arabic and English' : b.language === 'fr' ? 'French' : 'English'} · confidence ${Math.round((b.confidence || 0) * 100)}%</p>
      </div>
    </div>

    ${done ? `<div class="notice ok"><strong>${esc(item.result.name || 'Draft')} created in Odoo.</strong> Check it and post it there. <a href="${esc(item.result.url)}" target="_blank" rel="noopener">Open in Odoo</a>${item.result.warnings?.length ? `<ul>${item.result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}</div>` : ''}
    ${item.error ? `<div class="notice error">${esc(item.error)}${item.dupUrl ? ` <a href="${esc(item.dupUrl)}" target="_blank" rel="noopener">Open existing</a> <button class="btn small" id="forceBtn">Create anyway</button>` : ''}</div>` : ''}
    ${b.warnings.length && !done ? `<ul class="notice warn">${b.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    ${b.notes && !done ? `<p class="notes">${esc(b.notes)}</p>` : ''}

    <fieldset class="kind" ${done ? 'disabled' : ''}>
      <legend>Record as</legend>
      ${[['bill', 'Vendor bill'], ['refund', 'Vendor refund'], ['entry', 'Journal entry']].map(([v, t]) =>
        `<label><input type="radio" name="kind" value="${v}" ${b.kind === v ? 'checked' : ''}> ${t}</label>`).join('')}
    </fieldset>

    <fieldset class="fields" ${done ? 'disabled' : ''}>
      <div class="field vendor-field">
        <label for="fVendor">Vendor</label>
        <input id="fVendor" value="${esc(b.partnerName || b.vendor.name)}" autocomplete="off">
        <p class="hint" id="vendorHint">${b.partnerId ? 'Linked to the Odoo contact.' : state.health?.autoCreatePartner ? 'No Odoo contact matched. A new vendor will be created.' : 'Pick a vendor from Odoo.'}</p>
        <ul class="suggest" id="vendorSuggest" hidden></ul>
      </div>
      <div class="field"><label for="fRef">Bill reference</label><input id="fRef" value="${esc(b.ref)}"></div>
      <div class="field"><label for="fDate">Bill date</label><input id="fDate" type="date" value="${esc(b.date)}"></div>
      <div class="field" ${b.kind === 'entry' ? 'hidden' : ''}><label for="fDue">Due date</label><input id="fDue" type="date" value="${esc(b.dueDate)}"></div>
      <div class="field"><label for="fCur">Currency</label><select id="fCur">${currencyOptions(b.currency)}</select></div>
      <div class="field"><label for="fJournal">Journal</label><select id="fJournal">${journalOptions(b.kind === 'entry' ? 'general' : 'purchase', b.journalId)}</select></div>
    </fieldset>

    <div class="lines-wrap"><div id="lines"></div></div>

    <section class="ledger" aria-label="Debit and credit preview">
      <h3>How it will post</h3>
      <div id="ledger"></div>
    </section>

    ${done ? '' : `<div class="actions">
      <button class="btn primary big" id="sendBtn" ${item.status === 'sending' ? 'disabled' : ''}>${item.status === 'sending' ? 'Creating draft…' : 'Create draft in Odoo'}</button>
      <button class="btn ghost" id="removeBtn">Remove from batch</button>
    </div>`}
    <p class="muted small">Read by ${esc(item.model || 'AI')}. Nothing is posted — Odoo receives a draft with the scan attached.</p>
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

function renderLedger() {
  const item = current();
  const j = journalRows(item.bill, state.catalog);
  $('#ledger').innerHTML = `<table class="t-account">
    <thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
    <tbody>${j.rows.map((r) => `<tr class="${r.missing ? 'missing' : ''}">
      <td>${r.code ? `<span class="acc-code">${esc(r.code)}</span>` : ''}${esc(r.name)}<span class="memo">${esc(r.memo || '')}</span></td>
      <td class="num dr">${r.debit ? money(r.debit) : ''}</td>
      <td class="num cr">${r.credit ? money(r.credit) : ''}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>${j.balanced ? 'Balanced' : 'Not balanced'}</td><td class="num dr">${money(j.debit)}</td><td class="num cr">${money(j.credit)}</td></tr></tfoot>
  </table>`;
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
    b.journalId = defaultJournal(b.kind);
    renderReview();
  }));

  const bindField = (sel, key, ev = 'input') => $(sel)?.addEventListener(ev, (e) => { b[key] = e.target.value; renderLedger(); });
  bindField('#fRef', 'ref');
  bindField('#fDate', 'date');
  bindField('#fDue', 'dueDate');
  bindField('#fCur', 'currency', 'change');
  bindField('#fJournal', 'journalId', 'change');

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
    renderLedger();
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

async function send(item, allowDuplicate = false) {
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
      file: item.upload ? { name: item.upload.name, mimeType: item.upload.mimeType, base64: item.upload.base64 } : null,
      allowDuplicate,
    });
    item.status = 'done';
    const next = state.items.find((i) => i.status === 'review' && i !== item);
    if (next && !settings.auto) setTimeout(() => { state.selectedId = next.id; renderQueue(); renderReview(); }, 1800);
  } catch (err) {
    item.status = 'review';
    item.error = err.message;
    if (err.status === 409) item.dupUrl = err.details?.url || '';
  }
  renderQueue();
  if (item.id === state.selectedId) renderReview();
}

boot();
