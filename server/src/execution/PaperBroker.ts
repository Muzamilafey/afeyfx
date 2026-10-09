import type { OrderBook, OrderRequest, OrderStatus, Ticker } from '../types';
import { sleep } from '../utils/math';
import { env } from '../config/env';
import { FOREX_VENUE } from '../marketData/instruments';

export interface PaperConfig {
  feeRate: number;
  /** Extra adverse slippage applied on top of walking the book (market impact / queue). */
  slippagePct: number;
  latencyMs: number;
  /** Uniform jitter added to latency, as a fraction of latencyMs. */
  latencyJitter: number;
  /** Probability [0..1] that the simulated exchange rejects an order. */
  rejectRate: number;
  /** Max acceptable book age (ms) at fill time. */
  maxBookAgeMs: number;
}

export interface PaperFill {
  price: number;
  amount: number;
  fee: number;
  slippage: number; // quote-currency cost vs. top-of-book mid
}

export interface PaperExecution {
  status: OrderStatus;
  fills: PaperFill[];
  filled: number;
  averagePrice?: number;
  fee: number;
  rejectReason?: string;
  latencyMs: number;
  simulated: true;
}

export type MarketSnapshotFn = (exchange: string, symbol: string) => Promise<{ book: OrderBook | null; ticker: Ticker | null }> | { book: OrderBook | null; ticker: Ticker | null };

/**
 * Realistic paper-trading fill simulator. It never touches an exchange's order endpoints.
 *
 * Simulates: latency (price is re-sampled AFTER the delay), fees, spread (fills cross the book),
 * market impact (walks order-book levels), extra slippage, partial fills when liquidity is
 * insufficient, random exchange rejections, and rejection when no fresh book is available.
 */
export class PaperBroker {
  constructor(
    public cfg: PaperConfig,
    private snapshot: MarketSnapshotFn,
    private random: () => number = Math.random,
  ) {}

  async execute(req: OrderRequest, exchange = 'binance'): Promise<PaperExecution> {
    // Forex/metals are charged a broker-like commission (the spread is paid by filling at bid/ask).
    const feeRate = exchange === FOREX_VENUE ? Math.min(this.cfg.feeRate, env.FOREX_FEE_RATE) : this.cfg.feeRate;
    const latency = Math.round(this.cfg.latencyMs * (1 + (this.random() - 0.5) * 2 * this.cfg.latencyJitter));
    if (latency > 0) await sleep(latency);
    const reject = (reason: string): PaperExecution => ({ status: 'REJECTED', fills: [], filled: 0, fee: 0, rejectReason: reason, latencyMs: latency, simulated: true });

    if (!(req.amount > 0)) return reject('Invalid amount');
    if (this.random() < this.cfg.rejectRate) return reject('Simulated exchange rejection');

    const { book } = await this.snapshot(exchange, req.symbol);
    if (!book || !book.bids.length || !book.asks.length) return reject('No order book available - cannot simulate liquidity');
    if (Date.now() - book.timestamp > this.cfg.maxBookAgeMs) return reject('Order book is stale');

    const levels = req.side === 'buy' ? book.asks : book.bids;
    const mid = (book.bids[0].price + book.asks[0].price) / 2;

    let limit: number | undefined;
    if (req.type === 'limit') limit = req.price;
    if (req.type === 'stop_loss' || req.type === 'take_profit' || req.type === 'trailing_stop') limit = req.price; // triggered -> market (or limit if price given)

    if (limit !== undefined) {
      const top = levels[0].price;
      const marketable = req.side === 'buy' ? limit >= top : limit <= top;
      if (!marketable) {
        return { status: 'OPEN', fills: [], filled: 0, fee: 0, latencyMs: latency, simulated: true };
      }
    }

    const fills: PaperFill[] = [];
    let remaining = req.amount;
    for (const lvl of levels) {
      if (remaining <= 1e-12) break;
      if (limit !== undefined && (req.side === 'buy' ? lvl.price > limit : lvl.price < limit)) break;
      const take = Math.min(remaining, lvl.amount);
      if (take <= 0) continue;
      const adj = req.side === 'buy' ? lvl.price * (1 + this.cfg.slippagePct) : lvl.price * (1 - this.cfg.slippagePct);
      const price = limit !== undefined ? (req.side === 'buy' ? Math.min(adj, limit) : Math.max(adj, limit)) : adj;
      fills.push({ price, amount: take, fee: price * take * feeRate, slippage: Math.abs(price - mid) * take });
      remaining -= take;
    }

    const filled = fills.reduce((s, f) => s + f.amount, 0);
    if (filled <= 0) return reject('Insufficient liquidity');
    const notional = fills.reduce((s, f) => s + f.price * f.amount, 0);
    const fee = fills.reduce((s, f) => s + f.fee, 0);
    let status: OrderStatus = 'FILLED';
    if (remaining > 1e-12) {
      // Market orders: unfilled remainder is cancelled (IOC semantics). Limit orders keep resting.
      status = req.type === 'limit' ? 'PARTIALLY_FILLED' : 'CANCELLED';
    }
    return { status, fills, filled, averagePrice: notional / filled, fee, latencyMs: latency, simulated: true };
  }
}
