import { describe, it, expect } from 'vitest';
import { PaperBroker, type PaperConfig } from '../src/execution/PaperBroker';
import type { OrderBook } from '../src/types';

const cfg: PaperConfig = { feeRate: 0.001, slippagePct: 0.0005, latencyMs: 0, latencyJitter: 0, rejectRate: 0, maxBookAgeMs: 10_000 };
const book = (asks: [number, number][], bids: [number, number][], ts = Date.now()): OrderBook => ({ symbol: 'BTC/USDT', timestamp: ts, asks: asks.map(([price, amount]) => ({ price, amount })), bids: bids.map(([price, amount]) => ({ price, amount })) });
const snap = (b: OrderBook | null) => () => ({ book: b, ticker: null });
const req = (over = {}) => ({ symbol: 'BTC/USDT', side: 'buy' as const, type: 'market' as const, amount: 1, clientOrderId: 'x', ...over });

describe('PaperBroker', () => {
  it('fills market buys at the ask plus slippage and charges fees', async () => {
    const r = await new PaperBroker(cfg, snap(book([[100, 5]], [[99, 5]]))).execute(req());
    expect(r.status).toBe('FILLED');
    expect(r.averagePrice).toBeCloseTo(100 * 1.0005);
    expect(r.fee).toBeCloseTo(100 * 1.0005 * 0.001);
    expect(r.fills[0].slippage).toBeGreaterThan(0); // vs mid: pays half spread + slippage
  });

  it('walks the book (market impact) and partially fills when liquidity is insufficient', async () => {
    const r = await new PaperBroker(cfg, snap(book([[100, 0.5], [101, 0.3]], [[99, 5]]))).execute(req({ amount: 1 }));
    expect(r.filled).toBeCloseTo(0.8);
    expect(r.status).toBe('CANCELLED'); // IOC remainder cancelled
    expect(r.averagePrice!).toBeGreaterThan(100);
  });

  it('sells hit the bid', async () => {
    const r = await new PaperBroker(cfg, snap(book([[100, 5]], [[99, 5]]))).execute(req({ side: 'sell' }));
    expect(r.averagePrice).toBeCloseTo(99 * (1 - 0.0005));
  });

  it('rejects with no or stale order book', async () => {
    expect((await new PaperBroker(cfg, snap(null)).execute(req())).status).toBe('REJECTED');
    const stale = await new PaperBroker(cfg, snap(book([[100, 5]], [[99, 5]], Date.now() - 60_000))).execute(req());
    expect(stale.status).toBe('REJECTED');
    expect(stale.rejectReason).toMatch(/stale/);
  });

  it('simulates random exchange rejections', async () => {
    const r = await new PaperBroker({ ...cfg, rejectRate: 1 }, snap(book([[100, 5]], [[99, 5]]))).execute(req());
    expect(r.status).toBe('REJECTED');
    expect(r.rejectReason).toMatch(/Simulated/);
  });

  it('non-marketable limit orders rest; marketable ones fill no worse than the limit', async () => {
    const b = book([[100, 5]], [[99, 5]]);
    expect((await new PaperBroker(cfg, snap(b)).execute(req({ type: 'limit', price: 98 }))).status).toBe('OPEN');
    const r = await new PaperBroker(cfg, snap(b)).execute(req({ type: 'limit', price: 100.02 }));
    expect(r.status).toBe('FILLED');
    expect(r.averagePrice!).toBeLessThanOrEqual(100.02);
  });

  it('simulates latency', async () => {
    const t = Date.now();
    const r = await new PaperBroker({ ...cfg, latencyMs: 60 }, snap(book([[100, 5]], [[99, 5]]))).execute(req());
    expect(Date.now() - t).toBeGreaterThanOrEqual(55);
    expect(r.latencyMs).toBeGreaterThanOrEqual(55);
  });
});
