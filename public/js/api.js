const TOKEN_KEY = 'billAgent.token';

export const auth = {
  get token() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } },
};

export class ApiError extends Error {
  constructor(message, status, details) { super(message); this.status = status; this.details = details; }
}

async function request(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`/api${path}`, { method, headers, body: form || (body ? JSON.stringify(body) : undefined) });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && path !== '/auth/login') window.dispatchEvent(new Event('auth:expired'));
  if (!res.ok) throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.details);
  return data;
}

export const api = {
  health: () => request('/health'),
  login: (password) => request('/auth/login', { method: 'POST', body: { password } }),
  catalog: (refresh) => request(`/odoo/catalog?allAccounts=1${refresh ? '&refresh=1' : ''}`),
  partners: (q) => request(`/odoo/partners?q=${encodeURIComponent(q)}`),
  extract: (blob, name) => {
    const form = new FormData();
    form.append('file', blob, name);
    return request('/bills/extract', { method: 'POST', form });
  },
  createDraft: (payload) => request('/bills', { method: 'POST', body: payload }),
  history: () => request('/bills/history'),
};
