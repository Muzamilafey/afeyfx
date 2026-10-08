import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import '../src/models';
import { createApp } from '../src/app';
import { reloadEnv } from '../src/config/env';
import { marketDataCache } from '../src/marketData/MarketDataCache';
import { orderExecutionService } from '../src/execution/OrderExecutionService';
import { forexDataService } from '../src/marketData/ForexDataService';
import { FOREX_VENUE, forexSessionOpen, instrumentOf, instruments, precisionFor, resetInstruments } from '../src/marketData/instruments';
import { OandaClient, setOandaFetch } from '../src/marketData/OandaClient';
import { BinanceWsStream } from '../src/marketData/BinanceWsStream';
import { SimulatedFeed } from '../src/marketData/SimulatedFeed';
import { usdPer } from '../src/portfolio/fx';
import { tradingState } from '../src/services/TradingState';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser } from './helpers/api';

const app = createApp();
const quote = (symbol: string, bid: number, ask: number) => {
  marketDataCache.setTicker(FOREX_VENUE, { symbol, timestamp: Date.now(), last: (bid + ask) / 2, bid, ask });
  marketDataCache.setOrderBook(FOREX_VENUE, { symbol, timestamp: Date.now(), bids: [{ price: bid, amount: 10_000_000 }], asks: [{ price: ask, amount: 10_000_000 }] });
  forexDataService.tradeable.set(symbol, true);
};

beforeAll(async () => {
  process.env.OANDA_API_TOKEN = 'test-token';
  process.env.OANDA_ACCOUNT_ID = '101-001-1-001';
  reloadEnv();
  resetInstruments();
  await connectTestDb();
  orderExecutionService.paperBroker.cfg = { ...orderExecutionService.paperBroker.cfg, latencyMs: 0, rejectRate: 0, slippagePct: 0, feeRate: 0 };
});
afterAll(async () => {
  delete process.env.OANDA_API_TOKEN;
  delete process.env.OANDA_ACCOUNT_ID;
  reloadEnv();
  resetInstruments();
  setOandaFetch(null);
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearDb();
  marketDataCache.clear();
  forexDataService.tradeable.clear();
  tradingState.reset();
  circuitBreaker.resetAll();
});

describe('instrument catalogue', () => {
  it('offers majors, crosses, exotics and metals alongside crypto when a forex source is configured', () => {
    const syms = instruments().map((i) => i.symbol);
    for (const s of ['EUR/USD', 'GBP/USD', 'USD/JPY', 'EUR/GBP', 'GBP/JPY', 'AUD/NZD', 'USD/ZAR', 'XAU/USD', 'XAG/USD', 'BTC/USDT', 'SOL/USDT', 'LINK/USDT']) expect(syms).toContain(s);
    expect(instrumentOf('EUR/USD')).toMatchObject({ category: 'forex', venue: 'oanda', pricePrecision: 5, venueId: 'EUR_USD' });
    expect(instrumentOf('USD/JPY')!.pricePrecision).toBe(3);
    expect(instrumentOf('XAU/USD')!.category).toBe('metals');
    expect(precisionFor('DOGE/USDT', 0.15)).toBe(5);
  });

  it('hides forex entirely when no price source is configured', () => {
    delete process.env.OANDA_API_TOKEN;
    reloadEnv();
    resetInstruments();
    expect(instruments().some((i) => i.category === 'forex')).toBe(false);
    process.env.OANDA_API_TOKEN = 'test-token';
    reloadEnv();
    resetInstruments();
  });

  it('knows the weekly forex session', () => {
    expect(forexSessionOpen(new Date('2026-10-07T12:00:00Z'))).toBe(true); // Wednesday
    expect(forexSessionOpen(new Date('2026-10-10T12:00:00Z'))).toBe(false); // Saturday
    expect(forexSessionOpen(new Date('2026-10-09T21:30:00Z'))).toBe(false); // Friday after close
    expect(forexSessionOpen(new Date('2026-10-11T21:30:00Z'))).toBe(true); // Sunday after open
  });
});

describe('forex trading on trader accounts', () => {
  it('USD-quoted pairs need no conversion; JPY-quoted P&L is converted to USD exactly', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    quote('EUR/USD', 1.0849, 1.0851);
    quote('USD/JPY', 149.99, 150.01);
    expect(usdPer('USD')).toBe(1);
    expect(usdPer('JPY')).toBeCloseTo(1 / 150, 10);
    expect(usdPer('EUR')).toBeCloseTo(1.085, 10);
    expect(usdPer('GBP')).toBeNull(); // no quote -> trading refused, never guessed

    const o = await request(app).post('/api/account/orders').set(t.auth).send({ symbol: 'USD/JPY', direction: 'LONG', investment: 1000, stopLossPct: 0.02 });
    expect(o.status).toBe(201);
    expect(o.body.position).toMatchObject({ exchange: 'oanda', entryPrice: 150.01 });
    expect(o.body.position.amount).toBeCloseTo(1000 / (1 / 150) / 150.01, 2); // ~1000 USD of exposure
    const acc1 = (await request(app).get('/api/account').set(t.auth)).body.account;
    expect(acc1.balance).toBeCloseTo(10_000 - o.body.position.amount * 150.01 / 150, 4);
    expect(acc1.equity).toBeCloseTo(10_000, 0);

    quote('USD/JPY', 151.5, 151.52);
    const c = await request(app).post(`/api/account/positions/${o.body.position._id}/close`).set(t.auth);
    expect(c.status).toBe(200);
    const amount = o.body.position.amount;
    const expectedUsd = ((151.5 - 150.01) * amount) / 151.51; // JPY P&L at the exit rate
    expect(c.body.trade.netPnl).toBeCloseTo(expectedUsd, 6);
    const acc2 = (await request(app).get('/api/account').set(t.auth)).body.account;
    expect(acc2.balance).toBeCloseTo(10_000 + expectedUsd, 6);
    expect(acc2.totalPnl).toBeCloseTo(expectedUsd, 6);
  });

  it('refuses closed markets, missing conversion rates and unknown symbols', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    quote('EUR/GBP', 0.8539, 0.8541);
    expect((await request(app).post('/api/account/orders').set(t.auth).send({ symbol: 'EUR/GBP', direction: 'LONG', investment: 100, stopLossPct: 0.02 })).body.error.code).toBe('NO_FX_RATE');
    quote('EUR/USD', 1.0849, 1.0851);
    forexDataService.tradeable.set('EUR/USD', false);
    expect((await request(app).post('/api/account/orders').set(t.auth).send({ symbol: 'EUR/USD', direction: 'LONG', investment: 100, stopLossPct: 0.02 })).body.error.code).toBe('MARKET_CLOSED');
    expect((await request(app).post('/api/account/orders').set(t.auth).send({ symbol: 'FOO/BAR', direction: 'LONG', investment: 100, stopLossPct: 0.02 })).body.error.code).toBe('UNKNOWN_SYMBOL');
  });

  it('the market summary lists every instrument with category, precision and session state', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    quote('EUR/USD', 1.0849, 1.0851);
    const r = (await request(app).get('/api/market-data/summary').set(t.auth)).body;
    expect(r.categories).toEqual(expect.arrayContaining(['crypto', 'forex', 'metals']));
    const eur = r.markets.find((m: { symbol: string }) => m.symbol === 'EUR/USD');
    expect(eur).toMatchObject({ category: 'forex', exchange: 'oanda', pricePrecision: 5, marketOpen: true, name: 'Euro / US Dollar' });
    expect(r.markets.find((m: { symbol: string }) => m.symbol === 'GBP/JPY')).toMatchObject({ unavailable: true });
  });
});

describe('market data sources', () => {
  it('parses OANDA pricing and closed candles; there are no order methods on the data client', async () => {
    setOandaFetch(async (url) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes('/pricing')
          ? { prices: [{ instrument: 'EUR_USD', time: '1760000000.000000000', tradeable: true, bids: [{ price: '1.08490', liquidity: 1000000 }], asks: [{ price: '1.08510', liquidity: 1000000 }] }] }
          : { candles: [{ time: '1760000000.0', complete: true, volume: 42, mid: { o: '1.0850', h: '1.0860', l: '1.0840', c: '1.0855' } }, { time: '1760000060.0', complete: false, volume: 3, mid: { o: '1', h: '1', l: '1', c: '1' } }] },
    }));
    const c = new OandaClient('t', 'a');
    expect(await c.pricing(['EUR_USD'])).toMatchObject([{ instrument: 'EUR_USD', bid: 1.0849, ask: 1.0851, tradeable: true, time: 1760000000000 }]);
    expect(await c.candles('EUR_USD', '1m')).toEqual([{ timestamp: 1760000000000, open: 1.085, high: 1.086, low: 1.084, close: 1.0855, volume: 42 }]);
    expect(Object.getOwnPropertyNames(OandaClient.prototype).filter((n) => /order|trade|transfer|withdraw/i.test(n))).toEqual([]);
    setOandaFetch(null);
  });

  it('Binance stream: every trade updates the price and forming candles stream live (only closed ones are stored)', () => {
    const onTrade = vi.fn();
    const onForming = vi.fn();
    const onClosed = vi.fn();
    const ws = new BinanceWsStream(['BTC/USDT'], ['1m'], { onTicker: vi.fn(), onClosedCandle: onClosed, onFormingCandle: onForming, onTrade, onStatus: vi.fn() });
    ws.handle({ stream: 'btcusdt@aggTrade', data: { s: 'BTCUSDT', p: '81736.01', T: 1 } });
    expect(onTrade).toHaveBeenCalledWith('BTC/USDT', 81736.01, 1);
    const k = (x: boolean) => ({ stream: 'btcusdt@kline_1m', data: { s: 'BTCUSDT', k: { t: 60_000, i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '10', x } } });
    ws.handle(k(false));
    ws.handle(k(false));
    expect(onForming).toHaveBeenCalledTimes(2);
    expect(onClosed).not.toHaveBeenCalled();
    ws.handle(k(true));
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('simulated forex moves in pips (not crypto-sized swings) and emits the forming candle on each tick', () => {
    const forming = vi.fn();
    const feed = new SimulatedFeed(['EUR/USD'], ['1m'], { onTicker: vi.fn(), onBook: vi.fn(), onClosedCandles: vi.fn(), onFormingCandle: forming }, 42);
    const h = feed.history(200).get('EUR/USD')!.get('1m')!;
    const closes = h.map((c) => c.close);
    expect(Math.max(...closes) / Math.min(...closes)).toBeLessThan(1.05);
    expect(closes.at(-1)!).toBeGreaterThan(1.0);
    feed.tick();
    expect(forming).toHaveBeenCalledWith('EUR/USD', '1m', expect.objectContaining({ close: expect.any(Number) }));
  });
});
