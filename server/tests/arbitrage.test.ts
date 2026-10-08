import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import '../src/models';
import { ArbitrageService } from '../src/services/ArbitrageService';
import { OrderExecutionService } from '../src/execution/OrderExecutionService';
import { PaperBroker } from '../src/execution/PaperBroker';
import { marketDataCache } from '../src/marketData/MarketDataCache';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { tradingState } from '../src/services/TradingState';
import { TradeModel } from '../src/models/Trade';
import { PortfolioModel } from '../src/models/Portfolio';
import { OrderModel } from '../src/models/Order';
import { StrategyModel } from '../src/models/Strategy';
import { portfolioService } from '../src/portfolio/PortfolioService';
import type { ArbitrageOpportunity } from '../src/strategies/ArbitrageStrategy';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';

const book = (ex: string, bid: number, ask: number, size = 10) =>
  marketDataCache.setOrderBook(ex, { symbol: 'BTC/USDT', timestamp: Date.now(), bids: [{ price: bid, amount: size }], asks: [{ price: ask, amount: size }] });
const svc = () =>
  new ArbitrageService(
    new OrderExecutionService(
      { submitTimeoutMs: 200, maxSubmitAttempts: 1, verifyTimeoutMs: 100, verifyIntervalMs: 10 },
      new PaperBroker({ feeRate: 0.001, slippagePct: 0, latencyMs: 0, latencyJitter: 0, rejectRate: 0, maxBookAgeMs: 10_000 }, (ex, s) => ({ book: marketDataCache.getOrderBook(ex, s)?.data ?? null, ticker: null })),
    ),
  );
const opp = (amount = 1): ArbitrageOpportunity => ({ buyExchange: 'binance', sellExchange: 'bybit', buyPrice: 100, sellPrice: 101, amount, grossSpreadPct: 0.01, grossProfit: amount, totalCosts: 0.2, expectedNetProfit: 0.8, expectedNetProfitPct: 0.008, executable: true, reasons: [] });

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearDb();
  marketDataCache.clear();
  circuitBreaker.resetAll();
  tradingState.reset();
  await portfolioService.get('PAPER');
  await StrategyModel.create({ key: 'arbitrage', name: 'Arbitrage', version: '1', enabled: true, stage: 'PAPER', symbols: ['BTC/USDT'] });
});

describe('arbitrage execution accounting', () => {
  it('books both legs as one trade and folds net P&L (after fees) into the portfolio', async () => {
    book('binance', 99.9, 100);
    book('bybit', 101, 101.1);
    const r = await svc().execute('PAPER', 'BTC/USDT', opp(1));
    expect(r.status).toBe('COMPLETED');
    const fees = 100 * 0.001 + 101 * 0.001;
    expect(r.netPnl).toBeCloseTo(1 - fees, 8);
    const t = await TradeModel.findOne({ strategyKey: 'arbitrage' });
    expect(t!.mode).toBe('PAPER');
    expect(t!.netPnl).toBeCloseTo(1 - fees, 8);
    const p = await PortfolioModel.findOne({ mode: 'PAPER' });
    expect(p!.balance).toBeCloseTo(10_000 + 1 - fees, 8);
    expect(p!.realizedPnl).toBeCloseTo(1 - fees, 8);
    expect(circuitBreaker.canOpenNewPositions()).toBe(true);
  });

  it('a legged execution trips the breaker, disables the strategy and books only the hedged part', async () => {
    book('binance', 99.9, 100, 10);
    book('bybit', 101, 101.1, 0.4); // only 0.4 liquidity on the sell venue
    const r = await svc().execute('PAPER', 'BTC/USDT', opp(1));
    expect(r.status).toBe('UNHEDGED');
    expect(r.hedgedAmount).toBeCloseTo(0.4);
    expect(circuitBreaker.isTripped('UNHEDGED_EXPOSURE')).toBe(true);
    expect((await StrategyModel.findOne({ key: 'arbitrage' }))!.enabled).toBe(false);
    expect((await TradeModel.findOne())!.amount).toBeCloseTo(0.4);
  });

  it('never leaves arbitrage legs resting on the book', async () => {
    book('binance', 99.9, 100.5); // buy limit 100 not marketable
    book('bybit', 101, 101.1);
    const r = await svc().execute('PAPER', 'BTC/USDT', opp(1));
    expect(r.status).toBe('UNHEDGED'); // sold without buying -> flagged
    expect(await OrderModel.countDocuments({ status: { $in: ['OPEN', 'PARTIALLY_FILLED'] } })).toBe(0);
  });
});
