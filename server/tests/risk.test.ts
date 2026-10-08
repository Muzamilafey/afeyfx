import { describe, it, expect } from 'vitest';
import { RiskEngine, DEFAULT_RISK_CONFIG, correlation, type RiskInput } from '../src/risk/RiskEngine';
import { CircuitBreaker } from '../src/risk/CircuitBreaker';

const base = (over: Partial<RiskInput> = {}): RiskInput => ({
  mode: 'PAPER',
  symbol: 'BTC/USDT',
  direction: 'LONG',
  entryPrice: 100,
  stopLoss: 98,
  takeProfit: 105,
  feeRate: 0.001,
  expectedSlippagePct: 0.0005,
  account: { equity: 10_000, available: 10_000, dayStartEquity: 10_000, weekStartEquity: 10_000 },
  openPositions: [],
  market: { bid: 99.99, ask: 100.01, dataAgeMs: 100, maxDataAgeMs: 30_000, minAmount: 0.001, amountPrecision: 6 },
  circuitBreaker: { open: false, reasons: [] },
  ...over,
});

describe('RiskEngine position sizing', () => {
  const r = new RiskEngine();

  it('risks at most MAX_RISK_PER_TRADE (0.5%) including costs', () => {
    const size = r.calculatePositionSize(10_000, 100, 98, 0.001, 0.0005);
    const loss = size * 2 + size * 100 * 2 * 0.0015;
    expect(loss).toBeLessThanOrEqual(50.0001);
    expect(loss).toBeGreaterThan(49);
  });

  it('returns 0 for invalid inputs', () => {
    expect(r.calculatePositionSize(0, 100, 98, 0, 0)).toBe(0);
    expect(r.calculatePositionSize(1000, 100, 100, 0, 0)).toBe(0);
    expect(r.calculatePositionSize(1000, NaN, 98, 0, 0)).toBe(0);
  });

  it('caps notional at MAX_PORTFOLIO_EXPOSURE (20%)', () => {
    // Very tight stop would imply a huge size; exposure cap must bound it.
    const e = r.evaluate(base({ stopLoss: 99.9, takeProfit: 101 }));
    expect(e.notional).toBeLessThanOrEqual(2000 + 1e-6);
    expect(e.exposureAfterPct).toBeLessThanOrEqual(0.2 + 1e-9);
  });
});

describe('RiskEngine evaluation', () => {
  const r = new RiskEngine();

  it('approves a well-formed trade', () => {
    const e = r.evaluate(base());
    expect(e.reasons).toEqual([]);
    expect(e.approved).toBe(true);
    expect(e.positionSize).toBeGreaterThan(0);
    expect(e.maxLoss).toBeLessThanOrEqual(50.01);
  });

  const reject = (name: string, over: Partial<RiskInput>, check: string) =>
    it(`rejects: ${name}`, () => {
      const e = r.evaluate(base(over));
      expect(e.approved).toBe(false);
      expect(e.positionSize).toBe(0);
      expect(e.reasons.some((x) => x.startsWith(check))).toBe(true);
    });

  reject('circuit breaker open', { circuitBreaker: { open: true, reasons: ['STALE'] } }, 'circuit-breaker');
  reject('stale data', { market: { ...base().market, dataAgeMs: 60_000 } }, 'data-fresh');
  reject('daily loss limit reached', { account: { equity: 9_790, available: 9_790, dayStartEquity: 10_000, weekStartEquity: 10_000 } }, 'daily-loss');
  reject('weekly loss limit reached', { account: { equity: 9_480, available: 9_480, dayStartEquity: 9_500, weekStartEquity: 10_000 } }, 'weekly-loss');
  reject('max open positions', { openPositions: Array.from({ length: 5 }, (_, i) => ({ symbol: `S${i}`, direction: 'LONG' as const, notional: 10 })) }, 'max-open-positions');
  reject('duplicate position', { openPositions: [{ symbol: 'BTC/USDT', direction: 'LONG', notional: 10 }] }, 'no-duplicate-position');
  reject('wide spread', { market: { ...base().market, bid: 99, ask: 101 } }, 'spread');
  reject('excessive expected slippage', { expectedSlippagePct: 0.01 }, 'slippage');
  reject('leverage above max', { leverage: 3 }, 'leverage');
  reject('stop on wrong side', { stopLoss: 101 }, 'stop-loss-valid');
  reject('poor reward:risk', { takeProfit: 100.5 }, 'reward-risk');
  reject('missing take profit', { takeProfit: undefined }, 'reward-risk');
  reject('short when shorting disabled', { direction: 'SHORT', stopLoss: 102, takeProfit: 95 }, 'short-allowed');
  reject('invalid numbers fail closed', { entryPrice: NaN }, 'inputs-valid');
  reject('exposure exhausted', { openPositions: [{ symbol: 'ETH/USDT', direction: 'LONG', notional: 2000 }] }, 'position-size');
  reject(
    'too many correlated positions',
    {
      openPositions: [
        { symbol: 'ETH/USDT', direction: 'LONG', notional: 10 },
        { symbol: 'SOL/USDT', direction: 'LONG', notional: 10 },
      ],
      correlations: { 'ETH/USDT': 0.9, 'SOL/USDT': 0.85 },
    },
    'correlation',
  );
  reject('no liquidity', { market: { ...base().market, availableLiquidity: 0 } }, 'liquidity');

  it('shorts are allowed only when explicitly enabled', () => {
    const r2 = new RiskEngine({ ...DEFAULT_RISK_CONFIG, allowShort: true });
    expect(r2.evaluate(base({ direction: 'SHORT', stopLoss: 102, takeProfit: 95 })).approved).toBe(true);
  });

  it('correlation helper', () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(correlation([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
  });
});

describe('CircuitBreaker', () => {
  it('fails closed on any trip and only auto-resets recoverable conditions', () => {
    const cb = new CircuitBreaker();
    expect(cb.canOpenNewPositions()).toBe(true);
    cb.checkDataFreshness(60_000, 30_000);
    expect(cb.canOpenNewPositions()).toBe(false);
    cb.checkDataFreshness(100, 30_000);
    expect(cb.canOpenNewPositions()).toBe(true);

    cb.checkDrawdown(0.021, 0.01, 0.02, 0.05);
    expect(cb.isTripped('DAILY_LOSS_LIMIT')).toBe(true);
    cb.recover('DAILY_LOSS_LIMIT');
    expect(cb.isTripped('DAILY_LOSS_LIMIT')).toBe(true); // requires a human
    cb.reset('DAILY_LOSS_LIMIT');
    expect(cb.canOpenNewPositions()).toBe(true);
  });

  it('trips on weekly loss, clock drift, abnormal spread, slippage and repeated API errors', () => {
    const cb = new CircuitBreaker({ apiErrorWindowMs: 60_000, apiErrorThreshold: 3 });
    cb.checkDrawdown(0, 0.06, 0.02, 0.05);
    cb.checkClockDrift(5000, 1000);
    cb.checkClockDrift(NaN, 1000);
    cb.checkSpread(0.05, 0.002, 'BTC/USDT');
    cb.checkSlippage(0.01, 0.003, 'BTC/USDT');
    cb.recordApiError('a');
    cb.recordApiError('b');
    expect(cb.isTripped('EXCHANGE_API_ERRORS')).toBe(false);
    cb.recordApiError('c');
    for (const c of ['WEEKLY_LOSS_LIMIT', 'CLOCK_DRIFT', 'ABNORMAL_SPREAD', 'EXCESSIVE_SLIPPAGE', 'EXCHANGE_API_ERRORS'] as const) {
      expect(cb.isTripped(c)).toBe(true);
    }
  });

  it('treats NaN data age as stale (fail closed)', () => {
    const cb = new CircuitBreaker();
    cb.checkDataFreshness(NaN, 30_000);
    expect(cb.canOpenNewPositions()).toBe(false);
  });

  it('notifies listeners', () => {
    const cb = new CircuitBreaker();
    const events: string[] = [];
    cb.onChange((e, t) => events.push(`${e}:${t.code}`));
    cb.trip('MANUAL_STOP', 'x');
    cb.reset('MANUAL_STOP');
    expect(events).toEqual(['trip:MANUAL_STOP', 'reset:MANUAL_STOP']);
  });
});
