// Turns whatever the user drops (photos, PDFs, ZIP files) into a list of bills to read.
//
//  expandUpload(files)  → quick: opens ZIPs, counts PDF pages, returns one "source" per bill.
//  prepareSource(src)   → slow, done right before that bill is read: shrinks the photo or
//                         renders the PDF page(s) to an image. Doing this lazily keeps memory
//                         low even for a 100-page PDF on a phone.
//
// Free vision models read images, not PDFs, so PDF pages are rendered to JPEG here.

const MAX_SIDE = 2000;          // photos are shrunk to this (keeps uploads well under 4 MB)
const PAGE_WIDTH = 1600;        // PDF pages are rendered at this width (~190 dpi for A4)
const WHOLE_PDF_PAGES = 4;      // "all pages are one bill": pages read together
const MAX_BILLS_PER_UPLOAD = 200;
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';
const JSZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

const EXT_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', pdf: 'application/pdf',
};
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const baseName = (name) => name.replace(/\.[^.]+$/, '');
const typeOf = (file) => file.type || EXT_TYPES[extOf(file.name)] || '';
const isZip = (file) => /zip/.test(file.type) || extOf(file.name) === 'zip';

/* ---------- script loading ---------- */

const scripts = new Map();
function loadScript(src, globalName) {
  if (!scripts.has(src)) {
    scripts.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve(window[globalName]);
      s.onerror = () => { scripts.delete(src); reject(new Error('Could not load a helper library. Check your internet connection.')); };
      document.head.appendChild(s);
    }));
  }
  return scripts.get(src);
}

async function pdfjs() {
  const lib = await loadScript(`${PDFJS}/pdf.min.js`, 'pdfjsLib');
  lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
  return lib;
}

const openDocs = new WeakMap();
function openPdf(file) {
  if (!openDocs.has(file)) {
    const p = (async () => (await pdfjs()).getDocument({ data: await file.arrayBuffer() }).promise)();
    p.catch(() => openDocs.delete(file));
    openDocs.set(file, p);
  }
  return openDocs.get(file);
}

/* ---------- ZIP ---------- */

async function unzip(file) {
  const JSZip = await loadScript(JSZIP, 'JSZip');
  let zip;
  try { zip = await JSZip.loadAsync(file); } catch { throw new Error(`${file.name} is not a valid ZIP file.`); }
  const entries = Object.values(zip.files)
    .filter((e) => !e.dir && !/(^|\/)(__MACOSX\/|\.)/.test(e.name)) // skip macOS junk & hidden files
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })); // bill2 before bill10
  const files = [];
  const skipped = [];
  for (const e of entries) {
    const name = e.name.split('/').pop();
    const type = EXT_TYPES[extOf(name)];
    if (!type) { skipped.push(name); continue; }
    files.push(new File([await e.async('blob')], name, { type }));
  }
  return { files, skipped };
}

/* ---------- expand ---------- */

/**
 * @param files     File[] from the input / drop / paste
 * @param askPdfMode ({name, pages}) => Promise<'split'|'whole'|'cancel'>, asked once per upload
 * @returns { sources, skipped }  one source per bill
 */
export async function expandUpload(files, { askPdfMode, onStatus = () => {} }) {
  const flat = [];
  const skipped = [];

  for (const f of files) {
    if (isZip(f)) {
      onStatus(`Opening ${f.name}…`);
      const { files: inner, skipped: junk } = await unzip(f);
      skipped.push(...junk.map((n) => `${n} (in ${f.name})`));
      if (!inner.length) skipped.push(`${f.name} (no photos or PDFs inside)`);
      flat.push(...inner);
    } else {
      flat.push(f);
    }
  }

  const sources = [];
  let pdfMode = null;
  for (const f of flat) {
    const type = typeOf(f);
    if (type === 'application/pdf') {
      onStatus(`Counting pages in ${f.name}…`);
      let doc;
      try { doc = await openPdf(f); } catch (e) {
        skipped.push(`${f.name} (${/password/i.test(e?.message) ? 'password-protected' : 'could not open'})`);
        continue;
      }
      const pages = doc.numPages;
      if (pages > 1 && !pdfMode) pdfMode = await askPdfMode({ name: f.name, pages });
      if (pages > 1 && pdfMode === 'cancel') { skipped.push(`${f.name} (cancelled)`); continue; }
      if (pages > 1 && pdfMode === 'split') {
        for (let p = 1; p <= pages; p++) {
          sources.push({ type: 'pdf-page', file: f, page: p, pages, name: `${baseName(f.name)} · page ${p}` });
        }
      } else {
        sources.push({ type: 'pdf-whole', file: f, pages, name: f.name });
      }
    } else if (type.startsWith('image/')) {
      sources.push({ type: 'image', file: f, name: f.name });
    } else {
      skipped.push(`${f.name} (not a photo or PDF)`);
    }
  }

  if (sources.length > MAX_BILLS_PER_UPLOAD) {
    skipped.push(`${sources.length - MAX_BILLS_PER_UPLOAD} bills over the ${MAX_BILLS_PER_UPLOAD}-per-upload limit — upload them separately`);
    sources.length = MAX_BILLS_PER_UPLOAD;
  }
  onStatus('');
  return { sources, skipped };
}

/* ---------- prepare one bill ---------- */

const toJpeg = (canvas, q = 0.85) => new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));

async function renderPage(doc, n) {
  const page = await doc.getPage(n);
  const scale = Math.min(3, PAGE_WIDTH / page.getViewport({ scale: 1 }).width);
  const viewport = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(viewport.width);
  c.height = Math.round(viewport.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return c;
}

function stack(canvases) {
  const width = Math.max(...canvases.map((c) => c.width));
  const height = canvases.reduce((h, c) => h + c.height, 0);
  const shrink = Math.min(1, 7000 / height);
  const out = document.createElement('canvas');
  out.width = Math.round(width * shrink);
  out.height = Math.round(height * shrink);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  let y = 0;
  for (const c of canvases) {
    ctx.drawImage(c, 0, y, c.width * shrink, c.height * shrink);
    y += c.height * shrink;
    c.width = 0; // release memory
  }
  return out;
}

async function shrinkPhoto(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await toJpeg(canvas);
    canvas.width = 0;
    if (blob && blob.size < file.size) return blob;
  } catch { /* e.g. HEIC outside Safari — send as-is */ }
  return null;
}

/**
 * Returns { ai, attach, previewUrl, note }
 *   ai     — the image the AI reads
 *   attach — the file attached to the Odoo draft
 */
export async function prepareSource(src) {
  if (src.type === 'image') {
    const small = await shrinkPhoto(src.file);
    const img = small
      ? { blob: small, mimeType: 'image/jpeg', name: `${baseName(src.file.name)}.jpg` }
      : { blob: src.file, mimeType: typeOf(src.file) || 'image/jpeg', name: src.file.name };
    return { ai: img, attach: img, previewUrl: null, note: '' };
  }

  const doc = await openPdf(src.file);

  if (src.type === 'pdf-page') {
    let blob = await toJpeg(await renderPage(doc, src.page));
    if (blob.size > 3.5 * 1024 * 1024) blob = await toJpeg(await renderPage(doc, src.page), 0.6);
    const img = { blob, mimeType: 'image/jpeg', name: `${baseName(src.file.name)} - page ${src.page}.jpg` };
    return { ai: img, attach: img, previewUrl: URL.createObjectURL(blob), note: '' };
  }

  // pdf-whole
  const count = Math.min(src.pages, WHOLE_PDF_PAGES);
  const canvases = [];
  for (let p = 1; p <= count; p++) canvases.push(await renderPage(doc, p));
  const blob = await toJpeg(stack(canvases));
  const ai = { blob, mimeType: 'image/jpeg', name: `${baseName(src.file.name)}.jpg` };
  // Attach the real PDF when it fits in one request; otherwise the rendered image.
  const attach = src.file.size * 1.37 < 4 * 1024 * 1024
    ? { blob: src.file, mimeType: 'application/pdf', name: src.file.name }
    : ai;
  return {
    ai,
    attach,
    previewUrl: URL.createObjectURL(blob),
    note: src.pages > WHOLE_PDF_PAGES ? `Only the first ${WHOLE_PDF_PAGES} of ${src.pages} pages were read.` : '',
  };
}

export function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(blob);
  });
}
