import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import '../src/models';
import { createApp } from '../src/app';
import { marketDataCache } from '../src/marketData/MarketDataCache';
import { orderExecutionService } from '../src/execution/OrderExecutionService';
import { PortfolioModel } from '../src/models/Portfolio';
import { PositionModel } from '../src/models/Position';
import { tradingState } from '../src/services/TradingState';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { SimulatedFeed, aggregate } from '../src/marketData/SimulatedFeed';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser } from './helpers/api';

const app = createApp();
const setBook = (bid: number, ask: number) => {
  marketDataCache.setTicker('binance', { symbol: 'BTC/USDT', timestamp: Date.now(), last: (bid + ask) / 2, bid, ask });
  marketDataCache.setOrderBook('binance', { symbol: 'BTC/USDT', timestamp: Date.now(), bids: [{ price: bid, amount: 100 }], asks: [{ price: ask, amount: 100 }] });
};

beforeAll(async () => {
  await connectTestDb();
  orderExecutionService.paperBroker.cfg = { ...orderExecutionService.paperBroker.cfg, latencyMs: 0, rejectRate: 0, slippagePct: 0 };
});
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearDb();
  marketDataCache.clear();
  tradingState.reset();
  circuitBreaker.resetAll();
});

describe('personal demo accounts', () => {
  it('each trader gets an isolated demo account; orders, positions and P&L never leak between users or into the system book', async () => {
    const alice = await makeUser(app, 'alice@x.io', 'trader');
    const bob = await makeUser(app, 'bob@x.io', 'trader');
    setBook(99.9, 100.1);
    const o = await request(app).post('/api/account/orders').set(alice.auth).send({ symbol: 'BTC/USDT', direction: 'LONG', investment: 1000, stopLossPct: 0.05, takeProfitPct: 0.1 });
    expect(o.status).toBe(201);
    expect(o.body.position.stopLoss).toBeCloseTo(100.1 * 0.95);
    const a = (await request(app).get('/api/account').set(alice.auth)).body.account;
    const b = (await request(app).get('/api/account').set(bob.auth)).body.account;
    expect(a.type).toBe('DEMO');
    expect(a.balance).toBeLessThan(10_000 - 999);
    expect(b.balance).toBe(10_000);
    expect((await request(app).get('/api/account/positions').set(bob.auth)).body.positions).toHaveLength(0);
    const pos = (await request(app).get('/api/account/positions').set(alice.auth)).body.positions;
    expect(pos).toHaveLength(1);
    // Bob cannot close Alice's position
    expect((await request(app).post(`/api/account/positions/${pos[0]._id}/close`).set(bob.auth)).status).toBe(404);
    // System book untouched, and admin system-book lists exclude personal accounts unless asked
    expect(await PortfolioModel.countDocuments({ owner: null })).toBe(0);
    const admin = await makeUser(app, 'admin@x.io', 'admin');
    expect((await request(app).get('/api/positions?mode=PAPER').set(admin.auth)).body.positions).toHaveLength(0);
    expect((await request(app).get('/api/orders?mode=PAPER').set(admin.auth)).body.orders).toHaveLength(0);
    expect((await request(app).get('/api/positions?mode=PAPER&owner=all').set(admin.auth)).body.positions).toHaveLength(1);
    setBook(104.9, 105.1);
    const c = await request(app).post(`/api/account/positions/${pos[0]._id}/close`).set(alice.auth);
    expect(c.status).toBe(200);
    expect(c.body.trade.netPnl).toBeGreaterThan(0);
    const hist = (await request(app).get('/api/account/history').set(alice.auth)).body.trades;
    expect(hist).toHaveLength(1);
    expect((await request(app).get('/api/account/history').set(bob.auth)).body.trades).toHaveLength(0);
    const after = (await request(app).get('/api/account').set(alice.auth)).body.account;
    expect(after.balance).toBeCloseTo(10_000 + c.body.trade.netPnl, 6);
  });

  it('rejects orders above the available balance, without market data, or during an emergency halt', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    expect((await request(app).post('/api/account/orders').set(t.auth).send({ symbol: 'BTC/USDT', direction: 'LONG', investment: 100 })).body.error.code).toBe('NO_MARKET_DATA');
    setBook(99.9, 100.1);
    expect((await request(app).post('/api/account/orders').set(t.auth).send({ symbol: 'BTC/USDT', direction: 'LONG', investment: 20_000 })).body.error.code).toBe('INSUFFICIENT_BALANCE');
    tradingState.update({ emergencyShutdown: true });
    expect((await request(app).post('/api/account/orders').set(t.auth).send({ symbol: 'BTC/USDT', direction: 'LONG', investment: 100 })).status).toBe(423);
  });

  it('short demo positions profit when price falls', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    setBook(99.9, 100.1);
    const o = await request(app).post('/api/account/orders').set(t.auth).send({ symbol: 'BTC/USDT', direction: 'SHORT', investment: 1000 });
    expect(o.status).toBe(201);
    setBook(94.9, 95.1);
    const c = await request(app).post(`/api/account/positions/${o.body.position._id}/close`).set(t.auth);
    expect(c.body.trade.netPnl).toBeGreaterThan(0);
  });

  it('demo reset requires a flat account', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    setBook(99.9, 100.1);
    await request(app).post('/api/account/orders').set(t.auth).send({ symbol: 'BTC/USDT', direction: 'LONG', investment: 500 });
    expect((await request(app).post('/api/account/demo/reset').set(t.auth)).status).toBe(409);
    await PositionModel.updateMany({}, { $set: { status: 'CLOSED' } });
    const r = await request(app).post('/api/account/demo/reset').set(t.auth);
    expect(r.status).toBe(200);
    expect(r.body.account.balance).toBe(10_000);
  });
});

describe('simulated market feed (development only)', () => {
  it('produces closed, aligned candles and consistent quotes', () => {
    const ticks: { bid: number; ask: number }[] = [];
    const closed: number[] = [];
    const f = new SimulatedFeed(['BTC/USDT'], ['1m', '5m'], { onTicker: (t) => ticks.push(t), onBook: () => undefined, onClosedCandles: (_s, _tf, cs) => closed.push(...cs.map((c) => c.timestamp)) }, 1);
    const hist = f.history(100).get('BTC/USDT')!;
    const m5 = hist.get('5m')!;
    expect(m5.length).toBeGreaterThan(50);
    for (const c of m5) {
      expect(c.timestamp % 300_000).toBe(0);
      expect(c.high).toBeGreaterThanOrEqual(Math.max(c.open, c.close));
    }
    expect(m5[m5.length - 1].timestamp + 300_000).toBeLessThanOrEqual(Date.now());
    const t0 = Math.floor(Date.now() / 60_000) * 60_000;
    f.tick(t0 + 1000);
    f.tick(t0 + 61_000);
    expect(closed).toContain(t0);
    expect(ticks.every((t) => t.ask > t.bid)).toBe(true);
  });

  it('aggregate() drops the incomplete bucket', () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const mins = Array.from({ length: 3 }, (_, i) => ({ timestamp: now - (3 - i) * 60_000, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    expect(aggregate(mins, 3_600_000).every((c) => c.timestamp + 3_600_000 <= now)).toBe(true);
  });
});
