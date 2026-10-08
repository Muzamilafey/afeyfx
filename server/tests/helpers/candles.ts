import type { Candle } from '../../src/types';

/** Deterministic pseudo-random generator (mulberry32) so tests are reproducible. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeCandles(n: number, opts: { start?: number; drift?: number; vol?: number; seed?: number; stepMs?: number; t0?: number } = {}): Candle[] {
  const r = rng(opts.seed ?? 42);
  const step = opts.stepMs ?? 3_600_000;
  let price = opts.start ?? 100;
  const out: Candle[] = [];
  const t0 = opts.t0 ?? Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const ret = (opts.drift ?? 0) + (r() - 0.5) * 2 * (opts.vol ?? 0.01);
    const open = price;
    const close = Math.max(0.01, open * (1 + ret));
    const high = Math.max(open, close) * (1 + r() * (opts.vol ?? 0.01) * 0.5);
    const low = Math.min(open, close) * (1 - r() * (opts.vol ?? 0.01) * 0.5);
    out.push({ timestamp: t0 + i * step, open, high, low, close, volume: 100 + r() * 50 });
    price = close;
  }
  return out;
}

export const linear = (n: number, from: number, to: number, stepMs = 3_600_000): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const c = from + ((to - from) * i) / (n - 1);
    return { timestamp: Date.UTC(2024, 0, 1) + i * stepMs, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 100 };
  });
