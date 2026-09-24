// OpenRouter free vision models ($0). Tries your configured models first, then any other
// free image-capable model OpenRouter currently lists, so a retired free model doesn't break scanning.
import { config } from '../../config.js';
import { AppError } from '../../utils/errors.js';
import { parseModelJson } from './normalize.js';

const API = 'https://openrouter.ai/api/v1';
const DEADLINE_MS = 55_000; // stay inside Vercel's 60 s function limit
let discovered = { at: 0, ids: [] };

const isFree = (m) => m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
const readsImages = (m) => (m.architecture?.input_modalities || []).includes('image') || /image/.test(m.architecture?.modality || '');

export async function freeVisionModels() {
  if (discovered.at > Date.now() - 60 * 60 * 1000 && discovered.ids.length) return discovered.ids;
  try {
    const res = await fetch(`${API}/models`, { signal: AbortSignal.timeout(8_000) });
    const { data = [] } = await res.json();
    const ids = data.filter((m) => isFree(m) && readsImages(m)).sort((a, b) => (b.context_length || 0) - (a.context_length || 0)).map((m) => m.id);
    discovered = { at: Date.now(), ids };
  } catch { /* keep configured models only */ }
  return discovered.ids;
}

async function candidateModels() {
  const { models, autoDiscover } = config.ai.openrouter;
  const extra = autoDiscover ? await freeVisionModels() : [];
  return [...new Set([...models, ...extra])].filter((id) => !config.ai.openrouter.freeOnly || id.endsWith(':free') || extra.includes(id));
}

export async function extractWithOpenRouter({ base64, mimeType, prompt }) {
  if (mimeType === 'application/pdf') {
    throw new AppError('Send the PDF as an image. The web page converts PDFs automatically — refresh it if you see this.');
  }
  const started = Date.now();
  const models = await candidateModels();
  if (!models.length) throw new AppError('No free vision model is available on OpenRouter right now. Set OPENROUTER_MODELS.', 503);

  const errors = [];
  for (const model of models.slice(0, 5)) {
    const remaining = DEADLINE_MS - (Date.now() - started);
    if (remaining < 8_000) break;
    let res;
    try {
      res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.ai.openrouter.apiKey}`,
          'HTTP-Referer': config.ai.openrouter.siteUrl,
          'X-Title': 'Bill Agent',
        },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 6000,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
            ],
          }],
        }),
        signal: AbortSignal.timeout(remaining - 2_000),
      });
    } catch (e) {
      errors.push(`${model}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
      continue;
    }

    const body = await res.text();
    let data = null;
    try { data = JSON.parse(body); } catch { /* not JSON */ }

    if (res.ok && !data?.error) {
      const choice = data?.choices?.[0];
      const text = choice?.message?.content || '';
      if (!text.trim()) { errors.push(`${model}: empty answer`); continue; }
      // Verify the reply actually contains a well-formed JSON object before trusting this
      // model — reasoning models sometimes wrap it in commentary or get cut off mid-object.
      try {
        parseModelJson(text);
        return { text, model };
      } catch {
        errors.push(`${model}: ${choice?.finish_reason === 'length' ? 'reply was cut off before the JSON closed' : 'reply was not valid JSON'}`);
        continue;
      }
    }

    const msg = data?.error?.message || body.slice(0, 200);
    if (res.status === 401) throw new AppError('OpenRouter rejected the API key. Check OPENROUTER_API_KEY.', 502);
    if (/data policy|no endpoints found/i.test(msg)) {
      throw new AppError('OpenRouter blocks free models with your privacy settings. Open openrouter.ai/settings/privacy and allow free endpoints, then try again.', 502);
    }
    errors.push(`${model}: ${res.status} ${msg}`);
  }

  const limited = errors.some((e) => / 429 /.test(e));
  throw new AppError(
    limited
      ? 'Free AI limit reached for now. Wait a minute (or until tomorrow if you hit the daily cap) and try again.'
      : `All free models failed. ${errors.join(' | ').slice(0, 600)}`,
    limited ? 429 : 502
  );
}