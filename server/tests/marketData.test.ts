import { describe, it, expect, vi } from 'vitest';
import { validateCandles } from '../src/marketData/candleUtils';
import { MarketDataCache } from '../src/marketData/MarketDataCache';
import { BinanceWsStream } from '../src/marketData/BinanceWsStream';

const H = 3_600_000;
const c = (t: number, o = {}) => ({ timestamp: t, open: 10, high: 11, low: 9, close: 10.5, volume: 1, ...o });

describe('candle validation', () => {
  it('rejects unclosed, misaligned, invalid candles and de-duplicates', () => {
    const now = 10 * H + 5;
    const r = validateCandles([c(H), c(H), c(2 * H), c(2 * H + 7), c(10 * H), c(3 * H, { high: 1 }), c(4 * H, { close: -1 }), c(5 * H, { volume: NaN })], '1h', now);
    expect(r.valid.map((x) => x.timestamp)).toEqual([H, 2 * H]);
    const reasons = r.rejected.map((x) => x.reason);
    expect(reasons).toContain('candle not closed yet');
    expect(reasons).toContain('timestamp not aligned to timeframe');
    expect(reasons).toContain('inconsistent OHLC');
    expect(reasons).toContain('non-positive price');
    expect(reasons).toContain('non-finite value');
  });

  it('detects gaps', () => {
    const r = validateCandles([c(H), c(2 * H), c(5 * H)], '1h', 100 * H);
    expect(r.gaps).toEqual([{ from: 3 * H, to: 4 * H }]);
  });
});

describe('MarketDataCache', () => {
  it('drops out-of-order tickers and merges candles without duplicates', () => {
    const m = new MarketDataCache();
    expect(m.setTicker('b', { symbol: 'X', timestamp: 2, last: 1, bid: 1, ask: 1 })).toBe(true);
    expect(m.setTicker('b', { symbol: 'X', timestamp: 1, last: 9, bid: 9, ask: 9 })).toBe(false);
    expect(m.getTicker('b', 'X')!.data.last).toBe(1);
    expect(m.mergeCandles('b', 'X', '1h', [c(H), c(2 * H)])).toHaveLength(2);
    expect(m.mergeCandles('b', 'X', '1h', [c(2 * H), c(3 * H)])).toHaveLength(1);
    expect(m.getCandles('b', 'X', '1h').map((x) => x.timestamp)).toEqual([H, 2 * H, 3 * H]);
  });

  it('reports infinite age when no data (treated as stale)', () => {
    expect(new MarketDataCache().dataAgeMs('b', 'X')).toBe(Infinity);
  });
});

describe('BinanceWsStream message handling', () => {
  const mk = () => {
    const h = { onTicker: vi.fn(), onClosedCandle: vi.fn(), onStatus: vi.fn() };
    return { h, ws: new BinanceWsStream(['BTC/USDT'], ['1m'], h) };
  };

  it('de-duplicates bookTicker events by update id', () => {
    const { h, ws } = mk();
    const ev = (u: number) => ({ stream: 'btcusdt@bookTicker', data: { s: 'BTCUSDT', u, b: '100', a: '101' } });
    ws.handle(ev(5));
    ws.handle(ev(5));
    ws.handle(ev(4));
    ws.handle(ev(6));
    expect(h.onTicker).toHaveBeenCalledTimes(2);
  });

  it('emits only closed klines, once each', () => {
    const { h, ws } = mk();
    const k = (t: number, x: boolean) => ({ stream: 'btcusdt@kline_1m', data: { s: 'BTCUSDT', k: { t, i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '10', x } } });
    ws.handle(k(60_000, false));
    ws.handle(k(60_000, true));
    ws.handle(k(60_000, true));
    expect(h.onClosedCandle).toHaveBeenCalledTimes(1);
    expect(h.onClosedCandle.mock.calls[0][2]).toMatchObject({ timestamp: 60_000, close: 1.5 });
  });

  it('ignores unknown symbols and malformed messages', () => {
    const { h, ws } = mk();
    ws.handle({ stream: 'ethusdt@bookTicker', data: { s: 'ETHUSDT', u: 1, b: '1', a: '2' } });
    ws.handle({});
    expect(h.onTicker).not.toHaveBeenCalled();
  });
});
