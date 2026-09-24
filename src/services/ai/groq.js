import { config } from '../../config.js';
import { AppError } from '../../utils/errors.js';

export async function extractWithGroq({ base64, mimeType, prompt }) {
  if (mimeType === 'application/pdf') {
    throw new AppError('Groq reads images only. Upload a photo/JPG of the bill, or switch AI_PROVIDER to gemini for PDFs.');
  }
  const { apiKey, model } = config.ai.groq;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      }],
    }),
    signal: AbortSignal.timeout(50_000),
  });
  if (!res.ok) throw new AppError(`Groq failed with HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`, 502);
  const data = await res.json();
  return { text: data.choices?.[0]?.message?.content || '', model };
}
