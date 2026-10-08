import { describe, it, expect } from 'vitest';
import { BacktestEngine } from '../src/backtesting/BacktestEngine';
import { WalkForwardAnalyzer, expandGrid } from '../src/backtesting/WalkForward';
import { createStrategy } from '../src/strategies/registry';
import { BaseStrategy, type MarketAnalysis, type StrategyContext } from '../src/strategies/Strategy';
import { computeMetrics, maxDrawdown, streaks } from '../src/portfolio/metrics';
import type { MarketRegime, SignalAction } from '../src/types';
import { makeCandles } from './helpers/candles';

/** Test strategy: goes LONG on every Nth closed bar; records what it saw. */
class ProbeStrategy extends BaseStrategy {
  id = 'probe';
  name = 'Probe';
  version = '0';
  description = 'test';
  allowedRegimes: MarketRegime[] = ['TRENDING_UP', 'TRENDING_DOWN', 'SIDEWAYS', 'LOW_VOLATILITY', 'HIGH_VOLATILITY', 'ABNORMAL'];
  requiredIndicators = [] as never[];
  seenLastTimestamps: number[] = [];
  minCandles = 60;
  constructor() {
    super({ every: 25, stopAtrMult: 2, rewardRisk: 2 });
  }
  generateSignal(ctx: StrategyContext) {
    this.seenLastTimestamps.push(ctx.candles[ctx.candles.length - 1].timestamp);
    return super.generateSignal(ctx);
  }
  protected entryLogic(ctx: StrategyContext, _a: MarketAnalysis): { action: SignalAction; confidence: number; reason: string } {
    return ctx.candles.length % this.params.every === 0 ? { action: 'LONG', confidence: 0.7, reason: 'probe' } : { action: 'HOLD', confidence: 0, reason: '' };
  }
}

const cfg = { timeframe: '1h' as const, startingBalance: 10_000, feeRate: 0.001, slippagePct: 0.0005, spreadPct: 0.0004, lookbackWindow: 300, risk: { minExpectedProfitPct: 0 } };

describe('BacktestEngine', () => {
  it('never shows the strategy a candle beyond the decision bar and fills at next open', () => {
    const candles = makeCandles(400, { seed: 3 });
    const s = new ProbeStrategy();
    const res = new BacktestEngine().run(s, candles, cfg);
    // Decisions are made on bars [start .. end-1]; the strategy never sees the final candle.
    expect(Math.max(...s.seenLastTimestamps)).toBeLessThan(candles[candles.length - 1].timestamp);
    expect(res.trades.length).toBeGreaterThan(3);
    for (const t of res.trades) {
      const idx = candles.findIndex((c) => c.timestamp === t.entryTime);
      // Entry is at bar idx's OPEN (adverse spread+slippage), decided at bar idx-1's close.
      expect(t.entryPrice).toBeCloseTo(candles[idx].open * (1 + 0.0002 + 0.0005), 8);
    }
  });

  it('results before time T are unaffected by data after T (no look-ahead)', () => {
    const a = makeCandles(600, { seed: 8, vol: 0.015 });
    const cut = 400;
    const b = a.slice(0, cut).concat(makeCandles(200, { seed: 77, start: a[cut].open * 3, vol: 0.05 }).map((c, i) => ({ ...c, timestamp: a[cut + i].timestamp })));
    for (const key of ['trend-following', 'mean-reversion', 'breakout', 'momentum', 'vwap']) {
      const ra = new BacktestEngine().run(createStrategy(key), a, cfg);
      const rb = new BacktestEngine().run(createStrategy(key), b, cfg);
      const closedBefore = (r: typeof ra) => r.trades.filter((t) => t.exitTime < a[cut].timestamp);
      expect(closedBefore(rb)).toEqual(closedBefore(ra));
      const eqBefore = (r: typeof ra) => r.equityCurve.filter((p) => p.t < a[cut].timestamp);
      expect(eqBefore(rb)).toEqual(eqBefore(ra));
    }
  });

  it('charges fees and slippage on every trade', () => {
    const res = new BacktestEngine().run(new ProbeStrategy(), makeCandles(400, { seed: 3 }), cfg);
    for (const t of res.trades) {
      expect(t.fees).toBeGreaterThan(0);
      expect(t.slippage).toBeGreaterThan(0);
      expect(t.netPnl).toBeCloseTo(t.grossPnl - t.fees, 8);
    }
    expect(res.metrics.totalFees).toBeGreaterThan(0);
  });

  it('a zero-edge random-walk strategy loses money after costs', () => {
    const res = new BacktestEngine().run(new ProbeStrategy(), makeCandles(3000, { seed: 21, vol: 0.01 }), { ...cfg, feeRate: 0.002, slippagePct: 0.002 });
    expect(res.metrics.totalFees).toBeGreaterThan(0);
    expect(res.metrics.numberOfTrades).toBeGreaterThan(30);
    // Ending equity accounts for every fee - accounting identity.
    const sumNet = res.trades.reduce((s, t) => s + t.netPnl, 0);
    expect(res.metrics.endingEquity).toBeCloseTo(10_000 + sumNet, 6);
  });

  it('assumes stop-loss first when stop and target are hit in the same bar', () => {
    const candles = makeCandles(200, { seed: 5, vol: 0.002 });
    const s = new ProbeStrategy();
    s.params.every = 150;
    const res0 = new BacktestEngine().run(s, candles, cfg);
    const t0 = res0.trades[0];
    const idx = candles.findIndex((c) => c.timestamp === t0.entryTime);
    // Inject a huge-range bar right after entry: both stop and target touched.
    const mod = candles.map((c) => ({ ...c }));
    mod[idx + 1] = { ...mod[idx + 1], high: mod[idx + 1].open * 1.5, low: mod[idx + 1].open * 0.5 };
    const s2 = new ProbeStrategy();
    s2.params.every = 150;
    const res = new BacktestEngine().run(s2, mod, cfg);
    expect(res.trades[0].exitReason).toBe('STOP_LOSS');
    expect(res.trades[0].netPnl).toBeLessThan(0);
  });

  it('rejects unsorted candles', () => {
    const c = makeCandles(100);
    [c[10], c[11]] = [c[11], c[10]];
    expect(() => new BacktestEngine().run(new ProbeStrategy(), c, cfg)).toThrow(/ascending/);
  });

  it('warns when the sample is too small to be meaningful', () => {
    const res = new BacktestEngine().run(new ProbeStrategy(), makeCandles(200), cfg);
    expect(res.warnings.join(' ')).toMatch(/not statistically meaningful/);
  });
});

describe('metrics', () => {
  it('computes drawdown, streaks and reports undefined ratios as null', () => {
    expect(maxDrawdown([100, 120, 90, 130, 65])).toBeCloseTo(0.5);
    expect(streaks([1, 2, -1, -2, -3, 4])).toEqual({ longestWinStreak: 2, longestLossStreak: 3 });
    const m = computeMetrics([{ netPnl: 10 }, { netPnl: 5 }], [{ t: 0, equity: 100 }, { t: 1, equity: 115 }], 100, 365);
    expect(m.profitFactor).toBeNull();
    expect(m.sharpe).toBeNull();
    expect(m.winRate).toBe(1);
  });

  it('computes profit factor and expectancy', () => {
    const m = computeMetrics([{ netPnl: 30 }, { netPnl: -10 }, { netPnl: -10 }], [], 1000, 365);
    expect(m.profitFactor).toBeCloseTo(1.5);
    expect(m.expectancy).toBeCloseTo((1 / 3) * 30 - (2 / 3) * 10);
  });
});

describe('WalkForwardAnalyzer', () => {
  it('expands parameter grids with a cap', () => {
    expect(expandGrid({ a: [1, 2], b: [3, 4] }, 100)).toHaveLength(4);
    expect(expandGrid({ a: [1, 2, 3], b: [3, 4, 5] }, 5).length).toBeLessThanOrEqual(5);
  });

  it('rolls forward with non-overlapping OOS segments after train/validation', () => {
    const candles = makeCandles(1600, { seed: 13, vol: 0.012 });
    const res = new WalkForwardAnalyzer().run(
      'breakout',
      candles,
      { trainBars: 400, validationBars: 200, testBars: 200, paramGrid: { lookback: [20, 30] }, minTrainTrades: 1, topK: 2, maxCombinations: 10 },
      cfg,
    );
    expect(res.windows.length).toBeGreaterThanOrEqual(2);
    for (const w of res.windows) {
      expect(w.trainRange[1]).toBeLessThan(w.validationRange[0]);
      expect(w.validationRange[1]).toBeLessThan(w.testRange[0]);
      for (const t of w.oosTrades) expect(t.entryTime).toBeGreaterThanOrEqual(w.testRange[0]);
    }
    for (let i = 1; i < res.windows.length; i++) expect(res.windows[i].testRange[0]).toBeGreaterThan(res.windows[i - 1].testRange[1]);
  });
});
