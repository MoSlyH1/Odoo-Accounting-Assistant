const bool = (v, d = false) => (v === undefined || v === '' ? d : ['1', 'true', 'yes'].includes(String(v).toLowerCase()));
const list = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

export const config = {
  port: Number(process.env.PORT || 3000),
  auth: {
    password: process.env.APP_PASSWORD || '',
    secret: process.env.AUTH_SECRET || '',
    ttlHours: Number(process.env.AUTH_TTL_HOURS || 720),
  },
  odoo: {
    url: (process.env.ODOO_URL || '').replace(/\/+$/, ''),
    db: process.env.ODOO_DB || '',
    username: process.env.ODOO_USERNAME || '',
    apiKey: process.env.ODOO_API_KEY || process.env.ODOO_PASSWORD || '',
    companyId: process.env.ODOO_COMPANY_ID ? Number(process.env.ODOO_COMPANY_ID) : null,
    autoCreatePartner: bool(process.env.ODOO_AUTO_CREATE_PARTNER, true),
  },
  ai: {
    provider: (process.env.AI_PROVIDER || 'openrouter').toLowerCase(),
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY || '',
      models: list(process.env.OPENROUTER_MODELS, ['inclusionai/ling-3.0-flash-vl:free']),
      // When your models are unavailable, fall back to any other $0 image model OpenRouter lists.
      autoDiscover: bool(process.env.OPENROUTER_AUTO_DISCOVER, true),
      // Never call a paid model, even if listed in OPENROUTER_MODELS without ':free'.
      freeOnly: bool(process.env.OPENROUTER_FREE_ONLY, true),
      siteUrl: process.env.PUBLIC_URL || 'https://localhost',
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || '',
      models: list(process.env.GEMINI_MODELS, ['gemini-3-flash-preview', 'gemini-3.1-flash-lite']),
    },
    groq: {
      apiKey: process.env.GROQ_API_KEY || '',
      model: process.env.GROQ_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct',
    },
  },
  db: {
    url: process.env.DATABASE_URL || '',
    ssl: bool(process.env.DATABASE_SSL, false),
  },
  upload: {
    maxBytes: 4 * 1024 * 1024, // Vercel caps request bodies at 4.5 MB
    mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'],
  },
};

export function missingConfig() {
  const missing = [];
  if (!config.auth.password) missing.push('APP_PASSWORD');
  if (!config.auth.secret) missing.push('AUTH_SECRET');
  for (const k of ['url', 'db', 'username', 'apiKey']) if (!config.odoo[k]) missing.push(`ODOO_${k === 'apiKey' ? 'API_KEY' : k.toUpperCase()}`);
  if (config.ai.provider === 'openrouter' && !config.ai.openrouter.apiKey) missing.push('OPENROUTER_API_KEY');
  if (config.ai.provider === 'gemini' && !config.ai.gemini.apiKey) missing.push('GEMINI_API_KEY');
  if (config.ai.provider === 'groq' && !config.ai.groq.apiKey) missing.push('GROQ_API_KEY');
  return missing;
}
