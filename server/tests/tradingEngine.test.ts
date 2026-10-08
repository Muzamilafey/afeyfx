import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import '../src/models';
import { TradingEngine } from '../src/execution/TradingEngine';
import { STRATEGY_FACTORIES } from '../src/strategies/registry';
import { BaseStrategy, type MarketAnalysis, type StrategyContext } from '../src/strategies/Strategy';
import { StrategyModel } from '../src/models/Strategy';
import { SignalModel } from '../src/models/Signal';
import { PositionModel } from '../src/models/Position';
import { OrderModel } from '../src/models/Order';
import { RiskEventModel } from '../src/models/RiskEvent';
import { marketDataCache } from '../src/marketData/MarketDataCache';
import { tradingState } from '../src/services/TradingState';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { portfolioService } from '../src/portfolio/PortfolioService';
import { orderExecutionService } from '../src/execution/OrderExecutionService';
import { setClaudeService, ClaudeService } from '../src/ai/ClaudeService';
import type { MarketRegime, SignalAction } from '../src/types';
import { makeCandles } from './helpers/candles';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';

/** Always-LONG test strategy so the full pipeline can be exercised deterministically. */
class AlwaysLong extends BaseStrategy {
  id = 'test-long';
  name = 'Always Long';
  version = '1';
  description = 'test';
  allowedRegimes: MarketRegime[] = ['TRENDING_UP', 'TRENDING_DOWN', 'SIDEWAYS', 'LOW_VOLATILITY', 'HIGH_VOLATILITY'];
  requiredIndicators = ['atr'] as never[];
  minCandles = 60;
  constructor(p: Record<string, number> = {}) {
    super({ stopAtrMult: 2, rewardRisk: 3 }, p);
  }
  protected entryLogic(_c: StrategyContext, _a: MarketAnalysis): { action: SignalAction; confidence: number; reason: string } {
    return { action: 'LONG', confidence: 0.8, reason: 'test' };
  }
}
STRATEGY_FACTORIES['test-long'] = (p) => new AlwaysLong(p);

const H = 3_600_000;
function seedMarket(spread = 0.0002) {
  const lastOpen = Math.floor(Date.now() / H) * H - H; // most recent CLOSED 1h candle
  const candles = makeCandles(200, { drift: 0.002, vol: 0.004, t0: lastOpen - 199 * H });
  marketDataCache.mergeCandles('binance', 'BTC/USDT', '1h', candles);
  const px = candles[candles.length - 1].close;
  const bid = px * (1 - spread / 2);
  const ask = px * (1 + spread / 2);
  marketDataCache.setTicker('binance', { symbol: 'BTC/USDT', timestamp: Date.now(), last: px, bid, ask });
  marketDataCache.setOrderBook('binance', { symbol: 'BTC/USDT', timestamp: Date.now(), bids: [{ price: bid, amount: 50 }], asks: [{ price: ask, amount: 50 }] });
}

beforeAll(async () => {
  await connectTestDb();
  orderExecutionService.paperBroker.cfg = { ...orderExecutionService.paperBroker.cfg, latencyMs: 0, rejectRate: 0 };
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearDb();
  marketDataCache.clear();
  tradingState.reset();
  circuitBreaker.resetAll();
  setClaudeService(new ClaudeService(async () => { throw new Error('not used'); }));
  await StrategyModel.create({ key: 'test-long', name: 'Always Long', version: '1', enabled: true, stage: 'PAPER', symbols: ['BTC/USDT'], timeframes: ['1h'], params: {}, requireAiConfirmation: true });
  await portfolioService.get('PAPER');
});

describe('TradingEngine pipeline: market data -> strategy -> AI -> risk -> execution', () => {
  it('opens a PAPER position with risk-sized amount and full traceability', async () => {
    seedMarket();
    const out = await new TradingEngine().scan('test-long', 'BTC/USDT', '1h');
    expect(out.decision).toBe('EXECUTE');
    const pos = await PositionModel.findOne({ mode: 'PAPER' });
    expect(pos).not.toBeNull();
    const sig = await SignalModel.findById(out.signalId);
    const order = await OrderModel.findById(sig!.order);
    expect(order!.idempotencyKey).toBe(`entry:${sig!._id}`);
    expect(String(pos!.signal)).toBe(String(sig!._id));
    expect(pos!.riskEvaluation).toBeTruthy();
    // risk at the stop never exceeds 0.5% of equity (+ costs)
    expect(pos!.riskAmount!).toBeLessThanOrEqual(10_000 * 0.005 + 1e-6);
  });

  it('does not process the same candle twice (no duplicate signals/orders)', async () => {
    seedMarket();
    const e = new TradingEngine();
    await e.scan('test-long', 'BTC/USDT', '1h');
    const second = await e.scan('test-long', 'BTC/USDT', '1h');
    expect(second.skipped ?? second.reasons?.[0]).toBeTruthy();
    expect(await OrderModel.countDocuments({ purpose: 'ENTRY' })).toBe(1);
  });

  it('does NOT trade when the circuit breaker is open', async () => {
    seedMarket();
    circuitBreaker.trip('STALE_MARKET_DATA', 'test');
    const out = await new TradingEngine().scan('test-long', 'BTC/USDT', '1h');
    expect(out.decision).toBe('REJECT');
    expect(await OrderModel.countDocuments()).toBe(0);
    expect(await RiskEventModel.countDocuments({ type: 'TRADE_REJECTED' })).toBe(1);
  });

  it('does NOT trade when the spread is abnormal', async () => {
    seedMarket(0.02);
    const out = await new TradingEngine().scan('test-long', 'BTC/USDT', '1h');
    expect(out.decision).toBe('REJECT');
    expect(out.reasons!.join()).toMatch(/spread/);
  });

  it('does NOT trade without an order book (cannot assess liquidity)', async () => {
    seedMarket();
    marketDataCache.clear();
    const lastOpen = Math.floor(Date.now() / H) * H - H;
    marketDataCache.mergeCandles('binance', 'BTC/USDT', '1h', makeCandles(200, { t0: lastOpen - 199 * H }));
    const out = await new TradingEngine().scan('test-long', 'BTC/USDT', '1h');
    expect(out.decision).toBe('REJECT');
  });

  it('does NOT trade on stale candles', async () => {
    marketDataCache.mergeCandles('binance', 'BTC/USDT', '1h', makeCandles(200, { t0: Date.UTC(2020, 0, 1) }));
    const out = await new TradingEngine().scan('test-long', 'BTC/USDT', '1h');
    expect(out.skipped).toMatch(/stale/);
  });

  it('does NOT trade when new trades are stopped', async () => {
    seedMarket();
    tradingState.update({ tradingEnabled: false });
    expect((await new TradingEngine().scan('test-long', 'BTC/USDT', '1h')).decision).toBe('REJECT');
  });

  it('AI enabled but failing => no trade (fail closed); AI veto => no trade', async () => {
    seedMarket();
    tradingState.update({ ai: { ...tradingState.get().ai, enabled: true } });
    expect((await new TradingEngine().scan('test-long', 'BTC/USDT', '1h')).decision).toBe('REJECT');

    await clearDb();
    await StrategyModel.create({ key: 'test-long', name: 'x', version: '1', enabled: true, stage: 'PAPER', symbols: ['BTC/USDT'], timeframes: ['1h'], params: {}, requireAiConfirmation: true });
    await portfolioService.get('PAPER');
    const create = vi.fn(async () => ({ content: [{ type: 'text', text: JSON.stringify({ symbol: 'BTC/USDT', signal: 'HOLD', confidence: 0.9, marketRegime: 'SIDEWAYS', riskLevel: 'HIGH', reason: 'mixed', keyRisks: [], dataQualityConcerns: [] }) }], stop_reason: 'end_turn', model: 'claude-opus-5-5' }));
    setClaudeService(new ClaudeService(create));
    const out = await new TradingEngine().scan('test-long', 'BTC/USDT', '1h');
    expect(create).toHaveBeenCalled();
    expect(out.decision).toBe('REJECT');
    expect(out.reasons!.join()).toMatch(/ai-agreement/);
  });

  it('strategies not at PAPER stage are not scanned', async () => {
    seedMarket();
    await StrategyModel.updateOne({ key: 'test-long' }, { $set: { stage: 'BACKTEST' } });
    const e = new TradingEngine();
    e.start();
    expect(await e.scanAll()).toEqual([]);
  });
});
