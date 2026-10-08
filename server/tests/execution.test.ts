import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import * as ccxt from 'ccxt';
import '../src/models';
import { OrderExecutionService } from '../src/execution/OrderExecutionService';
import { PaperBroker } from '../src/execution/PaperBroker';
import { PositionManager } from '../src/execution/PositionManager';
import { CcxtAdapter } from '../src/exchanges/CcxtAdapter';
import { exchangeRegistry } from '../src/exchanges/registry';
import { tradingState } from '../src/services/TradingState';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { marketDataCache } from '../src/marketData/MarketDataCache';
import { OrderModel } from '../src/models/Order';
import { Fill } from '../src/models/Fill';
import { TradeModel } from '../src/models/Trade';
import { PortfolioModel } from '../src/models/Portfolio';
import { portfolioService } from '../src/portfolio/PortfolioService';
import { fakeCcxtClient } from './helpers/fakeExchange';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';

const fastCfg = { submitTimeoutMs: 200, maxSubmitAttempts: 3, verifyTimeoutMs: 300, verifyIntervalMs: 10 };
const setBook = (bid: number, ask: number) => {
  marketDataCache.setOrderBook('binance', { symbol: 'BTC/USDT', timestamp: Date.now(), bids: [{ price: bid, amount: 10 }], asks: [{ price: ask, amount: 10 }] });
  marketDataCache.setTicker('binance', { symbol: 'BTC/USDT', timestamp: Date.now(), last: (bid + ask) / 2, bid, ask });
};
const paperSvc = () =>
  new OrderExecutionService(
    fastCfg,
    new PaperBroker({ feeRate: 0.001, slippagePct: 0, latencyMs: 0, latencyJitter: 0, rejectRate: 0, maxBookAgeMs: 10_000 }, (ex, s) => ({ book: marketDataCache.getOrderBook(ex, s)?.data ?? null, ticker: null })),
  );

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearDb();
  marketDataCache.clear();
  tradingState.reset();
  circuitBreaker.resetAll();
  exchangeRegistry.clear();
  process.env.LIVE_TRADING_ENABLED = 'false';
});

describe('order execution (paper)', () => {
  it('idempotency: the same key never creates a second order or fill', async () => {
    setBook(99.9, 100.1);
    const svc = paperSvc();
    const intent = { mode: 'PAPER' as const, exchange: 'binance', symbol: 'BTC/USDT', side: 'buy' as const, type: 'market' as const, amount: 1, idempotencyKey: 'idem-1', purpose: 'ENTRY' as const };
    const [a, b] = await Promise.all([svc.submit(intent), svc.submit(intent)]);
    const c = await svc.submit(intent);
    expect(String(a._id)).toBe(String(b._id));
    expect(String(a._id)).toBe(String(c._id));
    expect(await OrderModel.countDocuments()).toBe(1);
    expect(await Fill.countDocuments()).toBe(1);
  });

  it('requires an idempotency key', async () => {
    await expect(paperSvc().submit({ mode: 'PAPER', exchange: 'binance', symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 1, idempotencyKey: '', purpose: 'ENTRY' })).rejects.toThrow(/idempotencyKey/);
  });

  it('open -> close creates a trade whose P&L includes fees on both sides, stored as PAPER', async () => {
    setBook(99.9, 100.1);
    await portfolioService.get('PAPER');
    const pm = new PositionManager(paperSvc());
    const { position } = await pm.open({ mode: 'PAPER', exchange: 'binance', symbol: 'BTC/USDT', direction: 'LONG', amount: 2, stopLoss: 95, takeProfit: 110, idempotencyKey: 'e1', strategyKey: 'test' });
    expect(position!.entryPrice).toBeCloseTo(100.1);
    setBook(104.9, 105.1);
    const r = await pm.close(position!._id.toString(), 'Take profit', 'TAKE_PROFIT', 'k');
    const t = r!.trade;
    expect(t.mode).toBe('PAPER');
    expect(t.grossPnl).toBeCloseTo((104.9 - 100.1) * 2);
    expect(t.fees).toBeCloseTo(100.1 * 2 * 0.001 + 104.9 * 2 * 0.001);
    expect(t.netPnl).toBeCloseTo(t.grossPnl! - t.fees!);
    const p = await PortfolioModel.findOne({ mode: 'PAPER' });
    expect(p!.balance).toBeCloseTo(10_000 + t.netPnl!, 6);
    expect(await TradeModel.countDocuments({ mode: 'LIVE' })).toBe(0);
  });

  it('position monitor triggers stop loss on bid', async () => {
    setBook(99.9, 100.1);
    await portfolioService.get('PAPER');
    const pm = new PositionManager(paperSvc());
    await pm.open({ mode: 'PAPER', exchange: 'binance', symbol: 'BTC/USDT', direction: 'LONG', amount: 1, stopLoss: 98, idempotencyKey: 'e2' });
    setBook(97.5, 97.7);
    await pm.monitor('PAPER');
    const t = await TradeModel.findOne();
    expect(t!.exitReason).toBe('Stop loss');
    expect(t!.netPnl!).toBeLessThan(0);
  });

  it('a rejected entry creates no position', async () => {
    const pm = new PositionManager(paperSvc());
    const r = await pm.open({ mode: 'PAPER', exchange: 'binance', symbol: 'BTC/USDT', direction: 'LONG', amount: 1, stopLoss: 98, idempotencyKey: 'e3' }); // no book
    expect(r.order.status).toBe('REJECTED');
    expect(r.position).toBeNull();
  });
});

describe('order execution (live, fully authorized, fake exchange)', () => {
  const arm = (client: Record<string, unknown>) => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    tradingState.update({ mode: 'LIVE', liveModeActive: true });
    exchangeRegistry.set('binance', new CcxtAdapter('binance', { testnet: true, credentials: { apiKey: 'k'.repeat(16), secret: 's'.repeat(16) }, client }));
  };
  const intent = (key: string) => ({ mode: 'LIVE' as const, exchange: 'binance', symbol: 'BTC/USDT', side: 'buy' as const, type: 'market' as const, amount: 1, idempotencyKey: key, purpose: 'ENTRY' as const });

  it('never assumes a fill from a successful create call; status comes from fetchOrder', async () => {
    const client = fakeCcxtClient({ fetchOrder: vi.fn(async (id: string, symbol: string) => ({ id, symbol, side: 'buy', type: 'market', amount: 1, filled: 0.4, remaining: 0.6, status: 'open' })) });
    arm(client);
    const o = await new OrderExecutionService(fastCfg).submit(intent('live-1'));
    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(client.fetchOrder).toHaveBeenCalled();
    expect(o.status).toBe('PARTIALLY_FILLED');
    expect(o.filled).toBeCloseTo(0.4);
    expect(o.exchangeResponses.length).toBeGreaterThan(0);
  });

  it('sends the idempotency key as clientOrderId', async () => {
    const client = fakeCcxtClient();
    arm(client);
    await new OrderExecutionService(fastCfg).submit(intent('live-2'));
    const params = (client.createOrder as ReturnType<typeof vi.fn>).mock.calls[0][5];
    expect(params.clientOrderId).toBe('live-2');
  });

  it('after a timeout it looks up the order by clientOrderId instead of blindly resubmitting', async () => {
    const client = fakeCcxtClient({
      createOrder: vi.fn(async () => {
        throw new ccxt.RequestTimeout('timeout');
      }),
      fetchOpenOrders: vi.fn(async () => [{ id: 'ex-77', clientOrderId: 'live-3', symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 1, filled: 0, status: 'open' }]),
    });
    arm(client);
    const o = await new OrderExecutionService(fastCfg).submit(intent('live-3'));
    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(o.exchangeOrderId).toBe('ex-77');
    expect(o.status).toBe('FILLED'); // verified via fetchOrder
  });

  it('definitive exchange rejections are not retried', async () => {
    const client = fakeCcxtClient({ createOrder: vi.fn(async () => { throw new ccxt.InsufficientFunds('no money'); }) });
    arm(client);
    const o = await new OrderExecutionService(fastCfg).submit(intent('live-4'));
    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(o.status).toBe('REJECTED');
  });

  it('unknown outcome after retries trips the circuit breaker', async () => {
    const client = fakeCcxtClient({ createOrder: vi.fn(async () => { throw new ccxt.NetworkError('down'); }) });
    arm(client);
    const o = await new OrderExecutionService(fastCfg).submit(intent('live-5'));
    expect(o.status).toBe('UNKNOWN');
    expect(client.createOrder).toHaveBeenCalledTimes(3);
    expect(circuitBreaker.canOpenNewPositions()).toBe(false);
  });
});
