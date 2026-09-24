// Provider-agnostic extraction. Add a new provider by adding a file and a case below.
import { config } from '../../config.js';
import { AppError } from '../../utils/errors.js';
import { buildPrompt } from './prompt.js';
import { extractWithGemini } from './gemini.js';
import { extractWithGroq } from './groq.js';
import { extractWithOpenRouter } from './openrouter.js';
import { parseModelJson, normalize } from './normalize.js';

const providers = { openrouter: extractWithOpenRouter, gemini: extractWithGemini, groq: extractWithGroq };

export async function extractBill({ base64, mimeType, catalog }) {
  const run = providers[config.ai.provider];
  if (!run) throw new AppError(`Unknown AI_PROVIDER "${config.ai.provider}". Use openrouter, gemini or groq.`, 500);

  const prompt = buildPrompt({ accounts: catalog.accounts, taxes: catalog.taxes, companyCurrency: catalog.company?.currency });
  const { text, model } = await run({ base64, mimeType, prompt });

  let raw;
  try {
    raw = parseModelJson(text);
  } catch {
    throw new AppError('The AI reply was not valid JSON. Try again or retake the photo.', 502, text.slice(0, 500));
  }
  return { bill: normalize(raw, catalog), raw, model };
}
