import { TIMEFRAME_MS, type Candle, type Timeframe } from '../types';

export interface CandleValidation {
  valid: Candle[];
  rejected: { candle: Candle; reason: string }[];
  gaps: { from: number; to: number }[];
}

/**
 * Validate a batch of candles: aligned timestamps, sane OHLC values, not in the future,
 * CLOSED (open time + timeframe <= now). Returns de-duplicated ascending candles and gaps.
 */
export function validateCandles(candles: Candle[], tf: Timeframe, now = Date.now()): CandleValidation {
  const step = TIMEFRAME_MS[tf];
  const rejected: CandleValidation['rejected'] = [];
  const byTs = new Map<number, Candle>();
  for (const c of candles) {
    let reason = '';
    if (!Number.isFinite(c.timestamp) || c.timestamp % step !== 0) reason = 'timestamp not aligned to timeframe';
    else if (c.timestamp + step > now) reason = 'candle not closed yet';
    else if (![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)) reason = 'non-finite value';
    else if (c.open <= 0 || c.close <= 0 || c.low <= 0) reason = 'non-positive price';
    else if (c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) reason = 'inconsistent OHLC';
    else if (c.volume < 0) reason = 'negative volume';
    if (reason) rejected.push({ candle: c, reason });
    else byTs.set(c.timestamp, c);
  }
  const valid = [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
  const gaps: CandleValidation['gaps'] = [];
  for (let i = 1; i < valid.length; i++) {
    if (valid[i].timestamp - valid[i - 1].timestamp > step) gaps.push({ from: valid[i - 1].timestamp + step, to: valid[i].timestamp - step });
  }
  return { valid, rejected, gaps };
}
