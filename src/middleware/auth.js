import crypto from 'node:crypto';
import { config } from '../config.js';
import { AppError } from '../utils/errors.js';

const sign = (payload) => crypto.createHmac('sha256', config.auth.secret).update(payload).digest('base64url');

export function issueToken() {
  const exp = Date.now() + config.auth.ttlHours * 3600 * 1000;
  const payload = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return { token: `${payload}.${sign(payload)}`, expiresAt: exp };
}

export function verifyToken(token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch {
    return false;
  }
}

export function checkPassword(input) {
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(config.auth.password).digest();
  return config.auth.password && crypto.timingSafeEqual(a, b);
}

export function requireAuth(req, _res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) return next(new AppError('Sign in again — your session is missing or expired.', 401));
  next();
}
