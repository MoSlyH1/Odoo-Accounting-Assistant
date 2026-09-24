// Minimal Odoo JSON-RPC client (works with Odoo 16, 17, 18, 19 — online and self-hosted).
import { config } from '../../config.js';
import { AppError } from '../../utils/errors.js';

let uidPromise = null; // cached per warm instance
let rpcId = 0;

async function rpc(service, method, args) {
  const res = await fetch(`${config.odoo.url}/jsonrpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params: { service, method, args }, id: ++rpcId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new AppError(`Odoo answered HTTP ${res.status}. Check ODOO_URL.`, 502);
  const data = await res.json();
  if (data.error) {
    const msg = data.error.data?.message || data.error.message || 'Unknown Odoo error';
    throw new AppError(`Odoo: ${msg}`, 502, data.error.data?.name);
  }
  return data.result;
}

export async function uid() {
  if (!uidPromise) {
    const { db, username, apiKey } = config.odoo;
    uidPromise = rpc('common', 'authenticate', [db, username, apiKey, {}]).then((id) => {
      if (!id) throw new AppError('Odoo rejected the login. Check ODOO_DB, ODOO_USERNAME and ODOO_API_KEY.', 502);
      return id;
    });
    uidPromise.catch(() => (uidPromise = null));
  }
  return uidPromise;
}

function withCompany(kwargs = {}) {
  if (!config.odoo.companyId) return kwargs;
  const context = { ...(kwargs.context || {}), allowed_company_ids: [config.odoo.companyId] };
  return { ...kwargs, context };
}

export async function call(model, method, args = [], kwargs = {}) {
  const { db, apiKey } = config.odoo;
  return rpc('object', 'execute_kw', [db, await uid(), apiKey, model, method, args, withCompany(kwargs)]);
}

export const searchRead = (model, domain = [], fields = [], opts = {}) =>
  call(model, 'search_read', [domain], { fields, ...opts });

export const create = (model, values, opts = {}) => call(model, 'create', [values], opts);

export const version = () => rpc('common', 'version', []);

export const recordUrl = (model, id) => `${config.odoo.url}/web#id=${id}&model=${model}&view_type=form`;
