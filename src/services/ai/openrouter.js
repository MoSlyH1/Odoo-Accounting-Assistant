// OpenRouter free vision models ($0).
// - Tries your configured models first (Qwen by default), then any other free model that
//   reads images and replies with text.
// - Gives each model as much of the time budget as it needs (AI_TIME_BUDGET_SECONDS).
// - Asks for strict JSON (structured outputs) so the reply is clean; falls back to plain
//   prompting only if a model rejects that option.
// - Waits and retries on the per-minute free limit; stops immediately on the daily limit.
import { config } from '../../config.js';
import { AppError } from '../../utils/errors.js';
import { parseModelJson } from './normalize.js';
import { BILL_SCHEMA } from './schema.js';

const API = 'https://openrouter.ai/api/v1';
let discovered = { at: 0, ids: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isFree = (m) => m.id.endsWith(':free') || (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0);
const readsImages = (m) => (m.architecture?.input_modalities || []).includes('image') || /image/.test(m.architecture?.modality || '');
// Must reply with text — some $0 models output audio or images (music generators etc.).
const producesText = (m) => (m.architecture?.output_modalities || ['text']).includes('text');

export async function freeVisionModels() {
  if (discovered.at > Date.now() - 60 * 60 * 1000 && discovered.ids.length) return discovered.ids;
  try {
    const res = await fetch(`${API}/models`, { signal: AbortSignal.timeout(8_000) });
    const { data = [] } = await res.json();
    const ids = data
      .filter((m) => isFree(m) && readsImages(m) && producesText(m))
      .sort((a, b) => (b.context_length || 0) - (a.context_length || 0))
      .map((m) => m.id);
    discovered = { at: Date.now(), ids };
  } catch { /* keep configured models only */ }
  return discovered.ids;
}

async function candidateModels() {
  const { models, autoDiscover, freeOnly } = config.ai.openrouter;
  const extra = autoDiscover ? await freeVisionModels() : [];
  return [...new Set([...models, ...extra])].filter((id) => !freeOnly || id.endsWith(':free') || extra.includes(id));
}

function requestBody(model, { base64, mimeType, prompt }, { schema, reasoning }) {
  const { maxTokens, reasoningEffort } = config.ai.openrouter;
  const body = {
    model,
    temperature: 0.1,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
      ],
    }],
  };
  if (schema) body.response_format = { type: 'json_schema', json_schema: { name: 'bill', strict: true, schema: BILL_SCHEMA } };
  // Let the model think before answering, but keep its thinking out of the reply text.
  if (reasoning && reasoningEffort !== 'off') body.reasoning = { effort: reasoningEffort, exclude: true };
  return body;
}

function retryAfterMs(res) {
  const s = Number(res.headers.get('retry-after'));
  if (s > 0) return s * 1000;
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (reset > Date.now()) return reset - Date.now();
  return null;
}

// One HTTP call. Returns { kind, ... } so the caller decides whether to retry.
async function callOnce(model, input, opts, timeoutMs) {
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
      body: JSON.stringify(requestBody(model, input, opts)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { kind: 'timeout', message: e.name === 'TimeoutError' ? `no answer within ${Math.round(timeoutMs / 1000)} s` : e.message };
  }

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* not JSON */ }
  const msg = data?.error?.message || data?.error?.metadata?.raw || raw.slice(0, 200);

  if (res.ok && !data?.error) {
    const choice = data?.choices?.[0];
    let text = choice?.message?.content ?? '';
    if (Array.isArray(text)) text = text.map((p) => p.text || '').join('');
    if (!String(text).trim()) return { kind: 'badjson', message: choice?.finish_reason === 'length' ? 'ran out of tokens before answering' : 'empty answer' };
    try {
      parseModelJson(text);
      return { kind: 'ok', text };
    } catch {
      return { kind: 'badjson', message: choice?.finish_reason === 'length' ? 'reply was cut off before the JSON closed' : 'reply was not valid JSON' };
    }
  }

  const status = res.status || data?.error?.code;
  if (status === 401) return { kind: 'auth' };
  if (/data policy|no endpoints found matching your data/i.test(msg)) return { kind: 'privacy' };
  if (status === 429) {
    if (/per.?day|daily/i.test(msg)) return { kind: 'daily', message: msg };
    return { kind: 'rate', message: msg, wait: retryAfterMs(res) };
  }
  if (status === 400 && /response_format|json_schema|structured|reasoning|unsupported|not supported/i.test(msg)) {
    return { kind: 'badparams', message: msg };
  }
  return { kind: 'unavailable', message: `${status} ${msg}` };
}

export async function extractWithOpenRouter(input) {
  if (input.mimeType === 'application/pdf') {
    throw new AppError('Send the PDF as an image. The web page converts PDFs automatically — refresh it if you see this.');
  }
  const deadline = Date.now() + config.ai.openrouter.timeBudgetMs;
  const models = await candidateModels();
  if (!models.length) throw new AppError('No free vision model is available on OpenRouter right now. Set OPENROUTER_MODELS.', 503);

  const errors = [];
  let rateLimited = false;

  models: for (const model of models.slice(0, 8)) {
    let opts = { schema: true, reasoning: true };
    let rateRetries = 0;
    let jsonRetries = 0;

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining < 15_000) break models;
      // The first model gets nearly the whole budget; later ones get whatever is left.
      const r = await callOnce(model, input, opts, remaining - 3_000);

      if (r.kind === 'ok') return { text: r.text, model };
      if (r.kind === 'auth') throw new AppError('OpenRouter rejected the API key. Check OPENROUTER_API_KEY.', 502);
      if (r.kind === 'privacy') {
        throw new AppError('OpenRouter blocks free models with your privacy settings. Open openrouter.ai/settings/privacy, allow free endpoints, then try again.', 502);
      }
      if (r.kind === 'daily') {
        throw new AppError('The daily free AI limit is used up. Waiting bills stay in the list — press Resume after the limit resets.', 429, { daily: true });
      }
      if (r.kind === 'rate') {
        rateLimited = true;
        if (rateRetries < 3) {
          rateRetries++;
          const wait = Math.min(r.wait ?? 12_000 * rateRetries, deadline - Date.now() - 20_000);
          if (wait > 0) { await sleep(wait); continue; }
        }
        errors.push(`${model}: busy (rate limit)`);
        continue models;
      }
      if (r.kind === 'badparams' && (opts.schema || opts.reasoning)) {
        opts = { schema: false, reasoning: false }; // this model doesn't take those options — ask plainly
        continue;
      }
      if (r.kind === 'badjson' && jsonRetries < 1) {
        jsonRetries++;
        opts = { ...opts, reasoning: false }; // a second, faster try on the same model
        continue;
      }
      errors.push(`${model}: ${r.message}`);
      continue models;
    }
  }

  if (rateLimited && !errors.some((e) => !/busy/.test(e))) {
    throw new AppError('Free AI is busy right now. The bill will be retried automatically.', 429);
  }
  throw new AppError(`All free models failed. ${errors.join(' | ').slice(0, 600) || 'Ran out of time.'}`, 502);
}
