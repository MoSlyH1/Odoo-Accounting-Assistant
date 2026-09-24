// Prepares uploads in the browser:
//  - photos are shrunk (keeps requests under Vercel's 4.5 MB limit)
//  - PDFs are rendered to one image (free vision models read images, not PDFs)
// The original file is kept separately so Odoo gets the real scan attached.
const MAX_SIDE = 2000;
const PDF_PAGES = 3; // bills are rarely longer; later pages are stacked below the first
const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174';

let pdfjsReady = null;
function loadPdfJs() {
  if (!pdfjsReady) {
    pdfjsReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${PDFJS}/pdf.min.js`;
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS}/pdf.worker.min.js`;
        resolve(window.pdfjsLib);
      };
      s.onerror = () => { pdfjsReady = null; reject(new Error('Could not load the PDF reader. Check your connection.')); };
      document.head.appendChild(s);
    });
  }
  return pdfjsReady;
}

const canvasToJpeg = (canvas) => new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
const baseName = (name) => name.replace(/\.[^.]+$/, '');

async function pdfToImage(file) {
  const pdfjs = await loadPdfJs();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= Math.min(doc.numPages, PDF_PAGES); i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1600 / base.width); // ~200 dpi for A4, sharp enough for small print
    const viewport = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.round(viewport.width);
    c.height = Math.round(viewport.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    pages.push(c);
  }
  const width = Math.max(...pages.map((p) => p.width));
  let height = pages.reduce((h, p) => h + p.height, 0);
  const shrink = Math.min(1, 4000 / height);
  const out = document.createElement('canvas');
  out.width = Math.round(width * shrink);
  out.height = Math.round(height * shrink);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  let y = 0;
  for (const p of pages) {
    ctx.drawImage(p, 0, y, p.width * shrink, p.height * shrink);
    y += p.height * shrink;
  }
  return { blob: await canvasToJpeg(out), pages: doc.numPages };
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
    const blob = await canvasToJpeg(canvas);
    if (blob && blob.size < file.size) return blob;
  } catch { /* e.g. HEIC outside Safari — send as-is */ }
  return null;
}

/**
 * Returns { ai: {blob, mimeType, name}, original: {blob, mimeType, name}, previewUrl, note }
 * `ai` is what the model reads; `original` is what gets attached in Odoo.
 */
export async function prepareFile(file) {
  if (file.type === 'application/pdf') {
    const { blob, pages } = await pdfToImage(file);
    return {
      ai: { blob, mimeType: 'image/jpeg', name: `${baseName(file.name)}.jpg` },
      original: { blob: file, mimeType: 'application/pdf', name: file.name },
      previewUrl: URL.createObjectURL(blob),
      note: pages > PDF_PAGES ? `Only the first ${PDF_PAGES} of ${pages} pages were read.` : '',
    };
  }
  const small = await shrinkPhoto(file);
  const img = small
    ? { blob: small, mimeType: 'image/jpeg', name: `${baseName(file.name)}.jpg` }
    : { blob: file, mimeType: file.type || 'image/jpeg', name: file.name };
  return { ai: img, original: img, previewUrl: null, note: '' };
}

export function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(blob);
  });
}
