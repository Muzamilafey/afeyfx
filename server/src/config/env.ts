import path from 'path';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load server/.env first, then the repository-root .env. Real environment variables always win.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: [path.resolve(process.cwd(), '.env'), path.resolve(__dirname, '../../../.env')], quiet: true });
}

/**
 * Environment configuration.
 *
 * Safety defaults:
 *  - TRADING_MODE defaults to PAPER
 *  - LIVE_TRADING_ENABLED defaults to false (hard kill switch; cannot be overridden from the UI)
 *  - Unknown / malformed boolean values are treated as false (fail closed)
 */

const bool = (def: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return def;
      if (typeof v === 'boolean') return v;
      return v.trim().toLowerCase() === 'true';
    });

const num = (def: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) {
        ctx.addIssue({ code: 'custom', message: `Invalid number: ${v}` });
        return z.NEVER;
      }
      return n;
    });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: num(5000),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/afeyfx'),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  JWT_SECRET: z.string().default(''),
  JWT_REFRESH_SECRET: z.string().default(''),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: num(7),
  ENCRYPTION_KEY: z.string().default(''),
  COOKIE_SECURE: bool(true),

  ANTHROPIC_API_KEY: z.string().default(''),
  AI_ENABLED: bool(false),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('medium'),
  AI_MAX_TOKENS: num(16000),
  AI_MIN_CONFIDENCE: num(0.65),

  BINANCE_API_KEY: z.string().default(''),
  BINANCE_API_SECRET: z.string().default(''),
  BINANCE_TESTNET: bool(true),
  BYBIT_API_KEY: z.string().default(''),
  BYBIT_API_SECRET: z.string().default(''),
  BYBIT_TESTNET: bool(true),
  COINBASE_API_KEY: z.string().default(''),
  COINBASE_API_SECRET: z.string().default(''),

  DEFAULT_EXCHANGE: z.string().default('binance'),
  MARKET_SYMBOLS: z.string().default('BTC/USDT,ETH/USDT'),
  MARKET_TIMEFRAMES: z.string().default('1m,5m,15m,1h'),
  MARKET_DATA_ENABLED: bool(true),
  MARKET_DATA_STALE_MS: num(30000),
  JOBS_ENABLED: bool(true),

  TRADING_MODE: z.enum(['BACKTEST', 'PAPER', 'LIVE']).default('PAPER'),
  LIVE_TRADING_ENABLED: bool(false),

  MAX_RISK_PER_TRADE: num(0.005),
  MAX_DAILY_LOSS: num(0.02),
  MAX_WEEKLY_LOSS: num(0.05),
  MAX_OPEN_POSITIONS: num(5),
  MAX_PORTFOLIO_EXPOSURE: num(0.2),
  MAX_LEVERAGE: num(1),
  MAX_SPREAD_PCT: num(0.002),
  MAX_SLIPPAGE_PCT: num(0.003),
  MAX_CLOCK_DRIFT_MS: num(1000),

  PAPER_STARTING_BALANCE: num(10000),
  PAPER_FEE_RATE: num(0.001),
  PAPER_SLIPPAGE_PCT: num(0.0005),
  PAPER_LATENCY_MS: num(150),
  PAPER_REJECT_RATE: num(0.01),

  NEWS_ENABLED: bool(false),
  NEWS_RSS_URLS: z.string().default(''),
  NEWS_MAX_AGE_HOURS: num(24),

  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_CHAT_ID: z.string().default(''),

  LOG_LEVEL: z.string().default('info'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('Invalid environment configuration', parsed.error.issues);
    throw new Error('Invalid environment configuration');
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    const missing: string[] = [];
    if (env.JWT_SECRET.length < 32) missing.push('JWT_SECRET (>=32 chars)');
    if (env.JWT_REFRESH_SECRET.length < 32) missing.push('JWT_REFRESH_SECRET (>=32 chars)');
    if (!/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY)) missing.push('ENCRYPTION_KEY (64 hex chars)');
    if (missing.length) throw new Error(`Missing/weak production secrets: ${missing.join(', ')}`);
  }
  return env;
}

export let env: Env = load();

/** Re-read process.env (used by tests that change env flags at runtime). */
export function reloadEnv(): Env {
  env = load();
  return env;
}

/**
 * The hard live-trading kill switch. Always re-read from process.env so that the value
 * cannot drift from what the operator configured, and any non-"true" value means disabled.
 */
export function isLiveTradingEnabledByEnv(): boolean {
  return String(process.env.LIVE_TRADING_ENABLED ?? '').trim().toLowerCase() === 'true';
}

export const symbolsFromEnv = () =>
  env.MARKET_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean);
export const timeframesFromEnv = () =>
  env.MARKET_TIMEFRAMES.split(',').map((s) => s.trim()).filter(Boolean);
