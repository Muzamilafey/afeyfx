import pino from 'pino';
import { env } from '../config/env';

/**
 * Structured JSON logger. Secrets are redacted by path, and free-form strings are passed
 * through `redactSecrets` where they might contain credentials (e.g. exchange error messages).
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'apiKey',
  '*.apiKey',
  'apiSecret',
  '*.apiSecret',
  'secret',
  '*.secret',
  'token',
  '*.token',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
  'twoFactorSecret',
  '*.twoFactorSecret',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'encryptedKey',
  'encryptedSecret',
];

export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: { service: 'afeyfx-server' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

const SECRET_PATTERNS: RegExp[] = [
  /(api[-_]?key|api[-_]?secret|secret|signature|token|password|passphrase)(["'\s:=]+)([^"'\s&,}]+)/gi,
  /bot\d{6,}:[A-Za-z0-9_-]{20,}/g, // telegram bot token in URLs
  /sk-ant-[A-Za-z0-9_-]+/g, // anthropic keys
];

/** Remove anything resembling credentials from a free-form string. */
export function redactSecrets(input: string): string {
  let out = input;
  out = out.replace(SECRET_PATTERNS[0], (_m, k: string, sep: string) => `${k}${sep}[REDACTED]`);
  out = out.replace(SECRET_PATTERNS[1], 'bot[REDACTED]');
  out = out.replace(SECRET_PATTERNS[2], '[REDACTED]');
  for (const v of [
    env.BINANCE_API_KEY,
    env.BINANCE_API_SECRET,
    env.BYBIT_API_KEY,
    env.BYBIT_API_SECRET,
    env.COINBASE_API_KEY,
    env.COINBASE_API_SECRET,
    env.TELEGRAM_BOT_TOKEN,
    env.ANTHROPIC_API_KEY,
    env.JWT_SECRET,
    env.ENCRYPTION_KEY,
  ]) {
    if (v && v.length >= 8) out = out.split(v).join('[REDACTED]');
  }
  return out;
}

export function errorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg);
}
