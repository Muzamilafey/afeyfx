import { describe, it, expect } from 'vitest';
import * as ind from '../src/services/analysis/indicators';
import { technicalAnalysis } from '../src/services/analysis/TechnicalAnalysisService';
import { makeCandles, linear } from './helpers/candles';

describe('indicators', () => {
  it('SMA computes rolling mean with NaN warm-up', () => {
    const r = ind.sma([1, 2, 3, 4, 5], 3);
    expect(r.slice(0, 2).every(Number.isNaN)).toBe(true);
    expect(r.slice(2)).toEqual([2, 3, 4]);
  });

  it('EMA seeds with SMA and converges toward constant series', () => {
    const r = ind.ema([2, 4, 6, 8, 10, 12], 3);
    expect(r[2]).toBe(4);
    expect(r[3]).toBeCloseTo(6);
    const flat = ind.ema(new Array(50).fill(7), 10);
    expect(flat[49]).toBeCloseTo(7);
  });

  it('RSI is 100 for monotonic gains, 0 for losses, ~50 balanced', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i);
    const down = Array.from({ length: 30 }, (_, i) => 100 - i);
    expect(ind.last(ind.rsi(up, 14))).toBe(100);
    expect(ind.last(ind.rsi(down, 14))).toBeCloseTo(0);
    const zig = Array.from({ length: 60 }, (_, i) => (i % 2 ? 101 : 100));
    expect(ind.last(ind.rsi(zig, 14))).toBeGreaterThan(40);
    expect(ind.last(ind.rsi(zig, 14))).toBeLessThan(60);
  });

  it('RSI matches the Wilder reference value', () => {
    // Classic Wilder example data (first RSI ~70.46 per StockCharts)
    const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
    expect(ind.rsi(closes, 14)[14]).toBeCloseTo(70.46, 1);
  });

  it('MACD line is positive in an uptrend', () => {
    const c = linear(100, 100, 200).map((x) => x.close);
    const m = ind.macd(c);
    expect(ind.last(m.macd)).toBeGreaterThan(0);
    expect(Number.isNaN(m.signal[40])).toBe(false);
  });

  it('Bollinger bands bracket price and collapse on constant series', () => {
    const c = makeCandles(100).map((x) => x.close);
    const b = ind.bollingerBands(c, 20, 2);
    expect(ind.last(b.upper)).toBeGreaterThan(ind.last(b.middle));
    expect(ind.last(b.lower)).toBeLessThan(ind.last(b.middle));
    const flat = ind.bollingerBands(new Array(30).fill(5), 20);
    expect(ind.last(flat.upper)).toBe(5);
    expect(ind.last(flat.percentB)).toBe(0.5);
  });

  it('ATR equals constant true range', () => {
    const candles = Array.from({ length: 30 }, (_, i) => ({ timestamp: i, open: 10, high: 11, low: 9, close: 10, volume: 1 }));
    expect(ind.last(ind.atr(candles, 14))).toBeCloseTo(2);
  });

  it('ADX is high in a strong trend with +DI > -DI', () => {
    const candles = Array.from({ length: 100 }, (_, i) => ({ timestamp: i, open: 100 + i, high: 101.5 + i, low: 99.5 + i, close: 101 + i, volume: 1 }));
    const a = ind.adx(candles, 14);
    expect(ind.last(a.adx)).toBeGreaterThan(40);
    expect(ind.last(a.plusDI)).toBeGreaterThan(ind.last(a.minusDI));
  });

  it('Stochastic is within [0,100]', () => {
    const s = ind.stochastic(makeCandles(100));
    const vals = s.k.filter((v) => !Number.isNaN(v));
    expect(vals.length).toBeGreaterThan(50);
    expect(vals.every((v) => v >= 0 && v <= 100)).toBe(true);
  });

  it('VWAP equals typical price for single bar and resets per session', () => {
    const day = 86_400_000;
    const candles = [
      { timestamp: 0, open: 10, high: 12, low: 8, close: 10, volume: 1 },
      { timestamp: day, open: 20, high: 22, low: 18, close: 20, volume: 5 },
    ];
    const v = ind.vwap(candles, day);
    expect(v[0]).toBeCloseTo(10);
    expect(v[1]).toBeCloseTo(20);
  });

  it('OBV accumulates by direction', () => {
    const candles = [10, 11, 10, 12].map((c, i) => ({ timestamp: i, open: c, high: c, low: c, close: c, volume: 10 }));
    expect(ind.obv(candles)).toEqual([0, 10, 0, 10]);
  });

  it('support/resistance finds swing levels', () => {
    const sr = ind.supportResistance(makeCandles(300, { vol: 0.02 }));
    expect(sr.supports.length).toBeGreaterThan(0);
    expect(sr.resistances.length).toBeGreaterThan(0);
  });

  it('indicators have no look-ahead: value at i unchanged when future data changes', () => {
    const a = makeCandles(200, { seed: 1 });
    const b = a.slice(0, 150).concat(makeCandles(50, { seed: 99, start: 500 }).map((c, i) => ({ ...c, timestamp: a[150 + i].timestamp })));
    const fns = [
      (x: typeof a) => ind.ema(x.map((c) => c.close), 20),
      (x: typeof a) => ind.rsi(x.map((c) => c.close), 14),
      (x: typeof a) => ind.atr(x, 14),
      (x: typeof a) => ind.adx(x, 14).adx,
      (x: typeof a) => ind.macd(x.map((c) => c.close)).histogram,
      (x: typeof a) => ind.bollingerBands(x.map((c) => c.close)).upper,
      (x: typeof a) => ind.stochastic(x).k,
      (x: typeof a) => ind.vwap(x),
      (x: typeof a) => ind.obv(x),
    ];
    for (const f of fns) {
      const ra = f(a);
      const rb = f(b);
      for (let i = 0; i < 150; i++) {
        if (Number.isNaN(ra[i])) expect(Number.isNaN(rb[i])).toBe(true);
        else expect(rb[i]).toBeCloseTo(ra[i], 10);
      }
    }
  });

  it('TechnicalAnalysisService only computes requested indicators', () => {
    const snap = technicalAnalysis.snapshot(makeCandles(200), { indicators: ['rsi', 'atr'] });
    expect(snap.rsi).toBeDefined();
    expect(snap.atr).toBeDefined();
    expect(snap.macd).toBeUndefined();
    expect(snap.bollinger).toBeUndefined();
  });
});
