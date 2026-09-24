import { config } from '../../config.js';
import { AppError } from '../../utils/errors.js';

const RETRYABLE = new Set([404, 429, 500, 503]);

export async function extractWithGemini({ base64, mimeType, prompt }) {
  const { apiKey, models } = config.ai.gemini;
  let lastError;
  for (const model of models) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mimeType, data: base64 } }, { text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
      }),
      signal: AbortSignal.timeout(50_000),
    }).catch((e) => ({ ok: false, status: 0, text: async () => e.message }));

    if (res.ok) {
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
      if (!text) {
        lastError = new AppError(`Gemini (${model}) returned no text: ${data.promptFeedback?.blockReason || 'empty response'}`, 502);
        continue;
      }
      return { text, model };
    }
    const body = await res.text();
    lastError = new AppError(`Gemini (${model}) failed with HTTP ${res.status}: ${body.slice(0, 300)}`, res.status === 429 ? 429 : 502);
    if (!RETRYABLE.has(res.status) && res.status !== 0) break;
  }
  throw lastError;
}
