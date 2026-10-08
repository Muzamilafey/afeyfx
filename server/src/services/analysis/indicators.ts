import type { Candle } from '../../types';

/**
 * Pure technical-indicator functions. Every function returns an array aligned with the input
 * (same length), using NaN where there is not yet enough data. Values at index i depend only on
 * inputs at indices <= i, so they are safe for bar-by-bar backtesting (no look-ahead).
 */

const nanArray = (n: number) => new Array<number>(n).fill(NaN);

export function sma(values: number[], period: number): number[] {
  const out = nanArray(values.length);
  if (period <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = nanArray(values.length);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((s, v) => s + v, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA), used by RSI/ATR/ADX. */
export function rma(values: number[], period: number, start = 0): number[] {
  const out = nanArray(values.length);
  const first = start + period - 1;
  if (values.length <= first) return out;
  let prev = 0;
  for (let i = start; i <= first; i++) prev += values[i];
  prev /= period;
  out[first] = prev;
  for (let i = first + 1; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes: number[], period = 14): number[] {
  const out = nanArray(closes.length);
  if (closes.length <= period) return out;
  const gains = [0];
  const losses = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(d, 0));
    losses.push(Math.max(-d, 0));
  }
  const ag = rma(gains, period, 1);
  const al = rma(losses, period, 1);
  for (let i = period; i < closes.length; i++) {
    if (Number.isNaN(ag[i])) continue;
    if (al[i] === 0) out[i] = ag[i] === 0 ? 50 : 100;
    else out[i] = 100 - 100 / (1 + ag[i] / al[i]);
  }
  return out;
}

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MACDResult {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => ef[i] - es[i]);
  const firstValid = line.findIndex((v) => !Number.isNaN(v));
  const signal = nanArray(closes.length);
  if (firstValid >= 0) {
    const sig = ema(line.slice(firstValid), signalPeriod);
    for (let i = 0; i < sig.length; i++) signal[firstValid + i] = sig[i];
  }
  const histogram = line.map((v, i) => v - signal[i]);
  return { macd: line, signal, histogram };
}

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
  percentB: number[];
}

export function bollingerBands(closes: number[], period = 20, mult = 2): BollingerResult {
  const middle = sma(closes, period);
  const upper = nanArray(closes.length);
  const lower = nanArray(closes.length);
  const bandwidth = nanArray(closes.length);
  const percentB = nanArray(closes.length);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += (closes[j] - middle[i]) ** 2;
    const sd = Math.sqrt(s / period);
    upper[i] = middle[i] + mult * sd;
    lower[i] = middle[i] - mult * sd;
    bandwidth[i] = middle[i] === 0 ? NaN : (upper[i] - lower[i]) / middle[i];
    percentB[i] = upper[i] === lower[i] ? 0.5 : (closes[i] - lower[i]) / (upper[i] - lower[i]);
  }
  return { upper, middle, lower, bandwidth, percentB };
}

export function trueRange(candles: Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const pc = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
  });
}

export function atr(candles: Candle[], period = 14): number[] {
  return rma(trueRange(candles), period);
}

export interface ADXResult {
  adx: number[];
  plusDI: number[];
  minusDI: number[];
}

export function adx(candles: Candle[], period = 14): ADXResult {
  const n = candles.length;
  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }
  const tr = trueRange(candles);
  const trS = rma(tr, period, 1);
  const pS = rma(plusDM, period, 1);
  const mS = rma(minusDM, period, 1);
  const plusDI = nanArray(n);
  const minusDI = nanArray(n);
  const dx = nanArray(n);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(trS[i]) || trS[i] === 0) continue;
    plusDI[i] = (100 * pS[i]) / trS[i];
    minusDI[i] = (100 * mS[i]) / trS[i];
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum === 0 ? 0 : (100 * Math.abs(plusDI[i] - minusDI[i])) / sum;
  }
  const firstDx = dx.findIndex((v) => !Number.isNaN(v));
  const adxOut = nanArray(n);
  if (firstDx >= 0) {
    const sm = rma(dx, period, firstDx);
    for (let i = 0; i < n; i++) adxOut[i] = sm[i];
  }
  return { adx: adxOut, plusDI, minusDI };
}

export interface StochasticResult {
  k: number[];
  d: number[];
}

export function stochastic(candles: Candle[], kPeriod = 14, dPeriod = 3, smooth = 3): StochasticResult {
  const n = candles.length;
  const raw = nanArray(n);
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j].high);
      ll = Math.min(ll, candles[j].low);
    }
    raw[i] = hh === ll ? 50 : (100 * (candles[i].close - ll)) / (hh - ll);
  }
  const k = smoothNaN(raw, smooth);
  const d = smoothNaN(k, dPeriod);
  return { k, d };
}

function smoothNaN(values: number[], period: number): number[] {
  const first = values.findIndex((v) => !Number.isNaN(v));
  const out = nanArray(values.length);
  if (first < 0) return out;
  const s = sma(values.slice(first), period);
  for (let i = 0; i < s.length; i++) out[first + i] = s[i];
  return out;
}

/**
 * VWAP. If `sessionMs` is given, VWAP resets at each session boundary (e.g. daily, UTC);
 * otherwise it is cumulative over the provided window.
 */
export function vwap(candles: Candle[], sessionMs?: number): number[] {
  const out = nanArray(candles.length);
  let pv = 0;
  let vol = 0;
  let session = -1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (sessionMs) {
      const s = Math.floor(c.timestamp / sessionMs);
      if (s !== session) {
        session = s;
        pv = 0;
        vol = 0;
      }
    }
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    vol += c.volume;
    out[i] = vol === 0 ? tp : pv / vol;
  }
  return out;
}

export function obv(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].close - candles[i - 1].close;
    out[i] = out[i - 1] + (d > 0 ? candles[i].volume : d < 0 ? -candles[i].volume : 0);
  }
  return out;
}

/** Rate of change (momentum) over `period` bars, as a fraction. */
export function roc(values: number[], period = 10): number[] {
  return values.map((v, i) => (i < period || values[i - period] === 0 ? NaN : (v - values[i - period]) / values[i - period]));
}

/** Rolling standard deviation of log returns (per-bar volatility). */
export function volatility(closes: number[], period = 20): number[] {
  const rets = closes.map((c, i) => (i === 0 || closes[i - 1] <= 0 ? NaN : Math.log(c / closes[i - 1])));
  const out = nanArray(closes.length);
  for (let i = period; i < closes.length; i++) {
    const w = rets.slice(i - period + 1, i + 1);
    const m = w.reduce((s, x) => s + x, 0) / period;
    out[i] = Math.sqrt(w.reduce((s, x) => s + (x - m) ** 2, 0) / (period - 1));
  }
  return out;
}

/** Volume relative to its moving average (1 = average). */
export function relativeVolume(candles: Candle[], period = 20): number[] {
  const v = candles.map((c) => c.volume);
  const avg = sma(v, period);
  return v.map((x, i) => (Number.isNaN(avg[i]) || avg[i] === 0 ? NaN : x / avg[i]));
}

export function highest(values: number[], period: number): number[] {
  const out = nanArray(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.max(m, values[j]);
    out[i] = m;
  }
  return out;
}

export function lowest(values: number[], period: number): number[] {
  const out = nanArray(values.length);
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.min(m, values[j]);
    out[i] = m;
  }
  return out;
}

export interface SupportResistance {
  supports: number[];
  resistances: number[];
}

/**
 * Pivot-based support/resistance: a swing high/low is confirmed only after `strength` bars
 * on its right have closed, so no future data is used relative to the last candle provided.
 */
export function supportResistance(candles: Candle[], strength = 3, maxLevels = 5, tolerance = 0.003): SupportResistance {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= strength; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) isHigh = false;
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) isLow = false;
    }
    if (isHigh) highs.push(candles[i].high);
    if (isLow) lows.push(candles[i].low);
  }
  const cluster = (levels: number[]) => {
    const out: number[] = [];
    for (const l of levels.slice().reverse()) {
      if (!out.some((x) => Math.abs(x - l) / x < tolerance)) out.push(l);
      if (out.length >= maxLevels) break;
    }
    return out.sort((a, b) => a - b);
  };
  return { supports: cluster(lows), resistances: cluster(highs) };
}

export const last = (arr: number[]) => arr[arr.length - 1];
export const lastValid = (arr: number[]) => {
  for (let i = arr.length - 1; i >= 0; i--) if (!Number.isNaN(arr[i])) return arr[i];
  return NaN;
};
