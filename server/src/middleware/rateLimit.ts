import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env';

const isTest = env.NODE_ENV === 'test';

export const apiLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 10_000 : 300, standardHeaders: 'draft-7', legacyHeaders: false });
/** Credential endpoints: only FAILED attempts count, so normal use never hits the limit but guessing does. */
export const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: isTest ? 10_000 : 20, skipSuccessfulRequests: true, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many failed attempts. Try again in a few minutes.' } } });
/** Session plumbing (token refresh, OAuth redirects): generous, every request counts. */
export const sessionLimiter = rateLimit({ windowMs: 15 * 60_000, limit: isTest ? 10_000 : 300, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } } });
export const protectedActionLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 1_000 : 10, standardHeaders: 'draft-7', legacyHeaders: false });
export const demoOrderLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 1_000 : 30, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? '') });
/** Deposit requests (each one pushes a prompt to the customer's phone). */
export const paymentLimiter = rateLimit({ windowMs: 10 * 60_000, limit: isTest ? 1_000 : 10, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ''), message: { error: { code: 'RATE_LIMITED', message: 'Too many payment requests. Try again in a few minutes.' } } });
/** Public M-Pesa callback endpoints. */
export const callbackLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 10_000 : 600, standardHeaders: 'draft-7', legacyHeaders: false });
/** Orders/closes on user broker accounts. */
export const brokerOrderLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 1_000 : 30, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? '') });
/** MT5 terminals poll about once a second plus quotes and heartbeats. */
export const bridgeLimiter = rateLimit({ windowMs: 60_000, limit: isTest ? 100_000 : 600, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (req) => String(req.headers['x-afx-terminal'] ?? ipKeyGenerator(req.ip ?? '')) });
