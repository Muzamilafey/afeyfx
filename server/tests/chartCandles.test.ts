import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import '../src/models';
import { createApp } from '../src/app';
import { reloadEnv } from '../src/config/env';
import { aggregateCalendar, bucketStart, chartCandleService, nextBucket } from '../src/marketData/ChartCandles';
import { marketDataCache } from '../src/marketData/MarketDataCache';
import { MarketDataService, setMarketDataService } from '../src/marketData/MarketDataService';
import { OandaClient, setOandaFetch } from '../src/marketData/OandaClient';
import { exchangeRegistry } from '../src/exchanges/registry';
import type { ExchangeAdapter } from '../src/exchanges/ExchangeAdapter';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';
import { makeUser } from './helpers/api';

const app = createApp();
const H = 3_600_000;
const utc = (s: string) => Date.parse(`${s}Z`);

/** Hourly candles ending at the current hour, with a deterministic drift. */
function hourly(hours: number) {
  const now = Math.floor(Date.now() / H) * H;
  return Array.from({ length: hours }, (_, i) => {
    const ts = now - (hours - i) * H;
    const open = 100 + i * 0.01;
    return { timestamp: ts, open, high: open + 0.5, low: open - 0.5, close: open + 0.01, volume: 10 };
  });
}

beforeAll(connectTestDb);
afterAll(async () => {
  setMarketDataService(null);
  setOandaFetch(null);
  delete process.env.MARKET_DATA_SOURCE;
  reloadEnv();
  await disconnectTestDb();
});
beforeEach(async () => {
  await clearDb();
  chartCandleService.clearCache();
});
afterEach(() => vi.restoreAllMocks());

describe('calendar buckets (UTC)', () => {
  it('aligns 4h and days to midnight, weeks to Monday and months to the 1st', () => {
    const t = utc('2026-10-08T13:45:10'); // a Thursday
    expect(new Date(bucketStart(t, '4h')).toISOString()).toBe('2026-10-08T12:00:00.000Z');
    expect(new Date(bucketStart(t, '1d')).toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(new Date(bucketStart(t, '1w')).toISOString()).toBe('2026-10-05T00:00:00.000Z'); // Monday
    expect(new Date(bucketStart(utc('2026-10-04T23:59:59'), '1w')).toISOString()).toBe('2026-09-28T00:00:00.000Z'); // Sunday → previous Monday
    expect(new Date(bucketStart(t, '1M')).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(new Date(nextBucket(utc('2026-01-01T00:00:00'), '1M')).toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(new Date(nextBucket(utc('2026-12-01T00:00:00'), '1M')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('aggregates OHLCV correctly into months of different lengths', () => {
    const days = [utc('2026-01-31T00:00:00'), utc('2026-02-01T00:00:00'), utc('2026-02-28T00:00:00'), utc('2026-03-01T00:00:00')];
    const out = aggregateCalendar(
      days.map((ts, i) => ({ timestamp: ts, open: 10 + i, high: 20 + i, low: 5 - i, close: 11 + i, volume: 1 })),
      '1M',
    );
    expect(out.map((c) => new Date(c.timestamp).toISOString().slice(0, 7))).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(out[1]).toMatchObject({ open: 11, high: 22, low: 3, close: 13, volume: 2 });
  });
});

describe('GET /api/market-data/candles with long timeframes', () => {
  it('simulated: every chart timeframe returns aligned, ascending candles plus the forming bucket', async () => {
    process.env.MARKET_DATA_SOURCE = 'simulated';
    reloadEnv();
    const md = new MarketDataService('binance', ['BTC/USDT'], ['1m', '1h']);
    setMarketDataService(md);
    marketDataCache.mergeCandles(md.exchange, 'BTC/USDT', '1h', hourly(24 * 30));
    marketDataCache.setTicker(md.exchange, { symbol: 'BTC/USDT', timestamp: Date.now(), last: 107.4, bid: 107.3, ask: 107.5 });
    const t = await makeUser(app, 't@x.io', 'trader');
    for (const tf of ['4h', '1d', '1w', '1M'] as const) {
      const r = await request(app).get(`/api/market-data/candles?symbol=BTC/USDT&timeframe=${tf}&limit=60`).set(t.auth);
      expect(r.status).toBe(200);
      const cs = r.body.candles as { timestamp: number; open: number; high: number; low: number; close: number }[];
      expect(cs.length).toBeGreaterThan(tf === '4h' ? 100 / 4 : 3);
      expect(cs.length).toBeLessThanOrEqual(60);
      for (let i = 0; i < cs.length; i++) {
        expect(cs[i].timestamp).toBe(bucketStart(cs[i].timestamp, tf));
        expect(cs[i].high).toBeGreaterThanOrEqual(Math.max(cs[i].open, cs[i].close));
        if (i) expect(cs[i].timestamp).toBeGreaterThan(cs[i - 1].timestamp);
      }
      expect(r.body.forming.timestamp).toBe(bucketStart(Date.now(), tf));
      expect(r.body.forming.close).toBe(107.4); // the latest price
      expect(r.body.source).toBe('simulated');
    }
  });

  it('live data: candles come from the venue at that size (Binance 1w), forming bar split off', async () => {
    process.env.MARKET_DATA_SOURCE = 'exchange';
    reloadEnv();
    setMarketDataService(new MarketDataService('binance', ['BTC/USDT'], ['1m', '1h']));
    const week = 7 * 24 * H;
    const cur = bucketStart(Date.now(), '1w');
    const getCandles = vi.fn(async (_s: string, tf: string) => {
      expect(tf).toBe('1w');
      return [cur - 2 * week, cur - week, cur].map((ts, i) => ({ timestamp: ts, open: 1 + i, high: 2 + i, low: 0.5, close: 1.5 + i, volume: 5 }));
    });
    vi.spyOn(exchangeRegistry, 'public').mockReturnValue({ getCandles } as unknown as ExchangeAdapter);
    const t = await makeUser(app, 't@x.io', 'trader');
    const r = await request(app).get('/api/market-data/candles?symbol=BTC/USDT&timeframe=1w&limit=10').set(t.auth);
    expect(r.body.source).toBe('exchange');
    expect(r.body.candles).toHaveLength(2);
    expect(r.body.forming.timestamp).toBe(cur);
  });

  it('OANDA chart candles are requested UTC-aligned with weeks starting Monday, forming candle kept', async () => {
    let url = '';
    setOandaFetch(async (u) => {
      url = u;
      return { ok: true, status: 200, json: async () => ({ candles: [{ time: '1759708800', complete: true, volume: 3, mid: { o: '1.1', h: '1.2', l: '1.0', c: '1.15' } }, { time: '1760313600', complete: false, volume: 1, mid: { o: '1.15', h: '1.16', l: '1.14', c: '1.155' } }] }) };
    });
    const rows = await new OandaClient('tok', 'acc').chartCandles('EUR_USD', 'W', 10);
    expect(url).toContain('granularity=W');
    expect(url).toContain('alignmentTimezone=UTC');
    expect(url).toContain('weeklyAlignment=Monday');
    expect(rows).toHaveLength(2);
    expect(rows[1].complete).toBe(false);
  });

  it('rejects unknown timeframes', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    expect((await request(app).get('/api/market-data/candles?symbol=BTC/USDT&timeframe=2w').set(t.auth)).status).toBe(400);
  });
});

describe('GET /api/market-data/ticks', () => {
  it('returns recent ticks in order, de-duplicated and capped', async () => {
    const t = await makeUser(app, 't@x.io', 'trader');
    marketDataCache.clear();
    const now = Date.now();
    for (let i = 0; i < 5; i++) marketDataCache.setTicker('binance', { symbol: 'BTC/USDT', timestamp: now + i * 1000, last: 100 + i, bid: 99 + i, ask: 101 + i });
    marketDataCache.setTicker('binance', { symbol: 'BTC/USDT', timestamp: now + 4000, last: 104, bid: 103, ask: 105 }); // duplicate
    const r = await request(app).get('/api/market-data/ticks?symbol=BTC/USDT&limit=3').set(t.auth);
    expect(r.status).toBe(200);
    expect(r.body.ticks.map((x: { price: number }) => x.price)).toEqual([102, 103, 104]);
  });
});
