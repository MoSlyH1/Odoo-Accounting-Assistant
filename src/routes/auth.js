import { Router } from 'express';
import { checkPassword, issueToken } from '../middleware/auth.js';
import { AppError } from '../utils/errors.js';

const router = Router();
const attempts = new Map(); // simple per-IP throttle (per instance)

router.post('/login', (req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return next(new AppError('Too many attempts. Wait a minute and try again.', 429));
  if (!checkPassword(req.body?.password)) {
    a.n += 1;
    if (a.n >= 5) Object.assign(a, { n: 0, until: Date.now() + 60_000 });
    attempts.set(ip, a);
    return next(new AppError('Wrong password.', 401));
  }
  attempts.delete(ip);
  res.json(issueToken());
});

export default router;
