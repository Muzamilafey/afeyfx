import { describe, it, expect } from 'vitest';
import { createStrategy, listStrategyKeys } from '../src/strategies/registry';
import { type RegimeResult } from '../src/services/analysis/MarketRegimeService';
import { ArbitrageStrategy } from '../src/strategies/ArbitrageStrategy';
import { makeCandles } from './helpers/candles';
import type { Candle } from '../src/types';

const regimeOf = (r: RegimeResult['regime']): RegimeResult => ({ regime: r, tags: [r], metrics: {} as RegimeResult['metrics'], reason: 'test' });

describe('strategy contract', () => {
  for (const key of listStrategyKeys()) {
    it(`${key} implements the required interface`, () => {
      const s = createStrategy(key);
      for (const p of ['id', 'name', 'version', 'description', 'timeframes', 'symbols', 'riskLevel']) expect(s).toHaveProperty(p);
      for (const m of ['analyzeMarket', 'generateSignal', 'validateEntry', 'calculateStopLoss', 'calculateTakeProfit', 'calculatePositionSize', 'shouldExit']) {
        expect(typeof (s as unknown as Record<string, unknown>)[m]).toBe('function');
      }
      expect(s.allowedRegimes.length).toBeGreaterThan(0);
    });
  }

  it('returns HOLD when there are not enough candles', () => {
    const s = createStrategy('trend-following');
    const sig = s.generateSignal({ symbol: 'X', timeframe: '1h', candles: makeCandles(20), regime: regimeOf('TRENDING_UP') });
    expect(sig.action).toBe('HOLD');
  });

  it('momentum strategy is disabled in SIDEWAYS regime', () => {
    const s = createStrategy('momentum');
    const sig = s.generateSignal({ symbol: 'X', timeframe: '1h', candles: makeCandles(200), regime: regimeOf('SIDEWAYS') });
    expect(sig.action).toBe('HOLD');
    expect(sig.reason).toMatch(/not in allowed/);
  });

  it('no strategy enters in ABNORMAL regime', () => {
    for (const key of listStrategyKeys()) {
      const sig = createStrategy(key).generateSignal({ symbol: 'X', timeframe: '1h', candles: makeCandles(300), regime: regimeOf('ABNORMAL') });
      expect(sig.action).toBe('HOLD');
    }
  });

  it('trend-following produces LONG with stop below and target above on a crossover', () => {
    // Downtrend then strong uptrend to force an EMA20/EMA50 cross up.
    const down = makeCandles(150, { drift: -0.002, vol: 0.002, seed: 5 });
    const up = makeCandles(150, { drift: 0.006, vol: 0.002, seed: 6, start: down[149].close }).map((c, i) => ({ ...c, timestamp: down[149].timestamp + (i + 1) * 3_600_000 }));
    const all = down.concat(up);
    const s = createStrategy('trend-following', { adxMin: 15 });
    let found = null;
    for (let i = 160; i < all.length; i++) {
      // Regime is supplied directly so this test isolates the strategy's own entry logic.
      const sig = s.generateSignal({ symbol: 'X', timeframe: '1h', candles: all.slice(0, i + 1), regime: regimeOf('TRENDING_UP') });
      if (sig.action === 'LONG') {
        found = sig;
        break;
      }
    }
    expect(found).not.toBeNull();
    expect(found!.stopLoss!).toBeLessThan(found!.price);
    expect(found!.takeProfit!).toBeGreaterThan(found!.price);
  });

  it('mean-reversion goes LONG below lower band with oversold RSI in sideways regime', () => {
    const base = makeCandles(120, { vol: 0.003, seed: 11 });
    const last = base[base.length - 1];
    const drops: Candle[] = Array.from({ length: 6 }, (_, i) => {
      const p = last.close * (1 - 0.012 * (i + 1));
      return { timestamp: last.timestamp + (i + 1) * 3_600_000, open: p * 1.012, high: p * 1.013, low: p * 0.999, close: p, volume: 120 };
    });
    const sig = createStrategy('mean-reversion').generateSignal({ symbol: 'X', timeframe: '1h', candles: base.concat(drops), regime: regimeOf('SIDEWAYS') });
    expect(sig.action).toBe('LONG');
    expect(sig.takeProfit!).toBeGreaterThan(sig.price);
  });

  it('validateEntry rejects a stop on the wrong side', () => {
    const s = createStrategy('breakout');
    const ctx = { symbol: 'X', timeframe: '1h', candles: makeCandles(150), regime: regimeOf('SIDEWAYS') };
    const v = s.validateEntry(ctx, { action: 'LONG', confidence: 0.6, price: 100, stopLoss: 101, takeProfit: 110, reason: '', indicators: { price: 100 }, regime: 'SIDEWAYS' });
    expect(v.valid).toBe(false);
  });

  it('calculatePositionSize risks exactly riskPerTrade of equity at the stop', () => {
    const s = createStrategy('trend-following');
    const size = s.calculatePositionSize(10_000, 100, 95, 0.005);
    expect(size * 5).toBeCloseTo(50);
  });

  it('shouldExit triggers on stop loss', () => {
    const s = createStrategy('trend-following');
    const candles = makeCandles(120);
    const price = candles[candles.length - 1].close;
    const ex = s.shouldExit({ symbol: 'X', timeframe: '1h', candles, regime: regimeOf('TRENDING_UP') }, { direction: 'LONG', entryPrice: price * 1.1, amount: 1, stopLoss: price * 1.05, openedAt: 0 });
    expect(ex.exit).toBe(true);
  });
});

describe('arbitrage', () => {
  const now = Date.now();
  const costs = { slippagePct: 0.0005, transferCost: 0, latencyPct: 0.0002, fundingPct: 0, maxQuoteAgeMs: 2000 };

  it('rejects an opportunity whose displayed spread is eaten by fees', () => {
    const s = new ArbitrageStrategy({ minNetProfitPct: 0.001 });
    const opp = s.evaluateOpportunity(
      [
        { exchange: 'a', bid: 99.9, ask: 100, bidSize: 5, askSize: 5, takerFee: 0.001, timestamp: now },
        { exchange: 'b', bid: 100.2, ask: 100.3, bidSize: 5, askSize: 5, takerFee: 0.001, timestamp: now },
      ],
      costs,
      now,
    )!;
    expect(opp.grossSpreadPct).toBeGreaterThan(0);
    expect(opp.expectedNetProfit).toBeLessThan(0);
    expect(opp.executable).toBe(false);
  });

  it('accepts only when net profit exceeds the minimum', () => {
    const s = new ArbitrageStrategy({ minNetProfitPct: 0.001, maxNotional: 1000 });
    const opp = s.evaluateOpportunity(
      [
        { exchange: 'a', bid: 99.9, ask: 100, bidSize: 5, askSize: 5, takerFee: 0.001, timestamp: now },
        { exchange: 'b', bid: 101, ask: 101.1, bidSize: 5, askSize: 5, takerFee: 0.001, timestamp: now },
      ],
      costs,
      now,
    )!;
    expect(opp.buyExchange).toBe('a');
    expect(opp.sellExchange).toBe('b');
    expect(opp.expectedNetProfitPct).toBeGreaterThan(0.001);
    expect(opp.executable).toBe(true);
    expect(opp.amount).toBeLessThanOrEqual(10);
  });

  it('rejects stale quotes and zero liquidity', () => {
    const s = new ArbitrageStrategy({ minNetProfitPct: 0.001 });
    const opp = s.evaluateOpportunity(
      [
        { exchange: 'a', bid: 99.9, ask: 100, bidSize: 5, askSize: 0, takerFee: 0.001, timestamp: now - 10_000 },
        { exchange: 'b', bid: 105, ask: 105.1, bidSize: 5, askSize: 5, takerFee: 0.001, timestamp: now },
      ],
      costs,
      now,
    )!;
    expect(opp.executable).toBe(false);
    expect(opp.reasons.join(' ')).toMatch(/Stale quote/);
  });
});
