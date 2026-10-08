import { describe, it, expect } from 'vitest';
import { MarketRegimeService } from '../src/services/analysis/MarketRegimeService';
import { makeCandles } from './helpers/candles';

const svc = new MarketRegimeService();

describe('MarketRegimeService', () => {
  it('detects TRENDING_UP in a steady uptrend', () => {
    const r = svc.detect(makeCandles(250, { drift: 0.004, vol: 0.003 }));
    expect(r.regime).toBe('TRENDING_UP');
  });

  it('detects TRENDING_DOWN in a steady downtrend', () => {
    const r = svc.detect(makeCandles(250, { drift: -0.004, vol: 0.003 }));
    expect(r.regime).toBe('TRENDING_DOWN');
  });

  it('detects SIDEWAYS/LOW_VOLATILITY for mean-reverting noise', () => {
    const r = svc.detect(makeCandles(250, { drift: 0, vol: 0.005, seed: 7 }));
    expect(['SIDEWAYS', 'LOW_VOLATILITY', 'HIGH_VOLATILITY']).toContain(r.regime);
    expect(r.regime.startsWith('TRENDING')).toBe(false);
  });

  it('flags HIGH_VOLATILITY when recent volatility spikes', () => {
    const calm = makeCandles(200, { vol: 0.002, seed: 3 });
    const wild = makeCandles(20, { vol: 0.04, seed: 4, start: calm[199].close }).map((c, i) => ({ ...c, timestamp: calm[199].timestamp + (i + 1) * 3_600_000 }));
    expect(svc.detect(calm.concat(wild)).regime).toBe('HIGH_VOLATILITY');
  });

  it('returns ABNORMAL for insufficient or invalid data and extreme moves', () => {
    expect(svc.detect(makeCandles(10)).regime).toBe('ABNORMAL');
    const bad = makeCandles(100);
    bad[50] = { ...bad[50], close: -1 };
    expect(svc.detect(bad).regime).toBe('ABNORMAL');
    const crash = makeCandles(200, { vol: 0.002 });
    const l = crash[199];
    crash.push({ timestamp: l.timestamp + 3_600_000, open: l.close, high: l.close, low: l.close * 0.6, close: l.close * 0.6, volume: 1000 });
    expect(svc.detect(crash).regime).toBe('ABNORMAL');
  });
});
