import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const isTest = env.NODE_ENV === 'test';

export const apiLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 10_000 : 300, standardHeaders: 'draft-7', legacyHeaders: false });
export const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: isTest ? 10_000 : 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many authentication attempts' } } });
export const protectedActionLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 1_000 : 10, standardHeaders: 'draft-7', legacyHeaders: false });
export const demoOrderLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 1_000 : 30, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => req.user?.id ?? req.ip ?? 'anon' });
