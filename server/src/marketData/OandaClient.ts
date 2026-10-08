import type { Candle, Timeframe } from '../types';

/**
 * Minimal OANDA v20 REST client for MARKET DATA ONLY (pricing + candles).
 * It deliberately has no order, trade, position or transfer methods: forex trades on trader
 * accounts are filled internally at OANDA's quoted bid/ask; nothing is ever sent to OANDA.
 */
export const OANDA_BASE = { practice: 'https://api-fxpractice.oanda.com', live: 'https://api-fxtrade.oanda.com' } as const;

const GRANULARITY: Partial<Record<Timeframe, string>> = { '1m': 'M1', '3m': 'M2', '5m': 'M5', '15m': 'M15', '30m': 'M30', '1h': 'H1', '4h': 'H4', '1d': 'D' };

export interface OandaPrice {
  instrument: string;
  time: number;
  bid: number;
  ask: number;
  tradeable: boolean;
  bids: { price: number; liquidity: number }[];
  asks: { price: number; liquidity: number }[];
}

type FetchFn = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
let fetchImpl: FetchFn = (url, init) => fetch(url, init);
export function setOandaFetch(f: FetchFn | null) {
  fetchImpl = f ?? ((url, init) => fetch(url, init));
}

export class OandaClient {
  constructor(
    private token: string,
    private accountId: string,
    private environment: 'practice' | 'live' = 'practice',
  ) {}

  private async get(path: string) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10_000);
    try {
      const r = await fetchImpl(`${OANDA_BASE[this.environment]}${path}`, { headers: { Authorization: `Bearer ${this.token}`, 'Accept-Datetime-Format': 'UNIX' }, signal: ctl.signal });
      const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
      if (!r.ok) throw new Error(`OANDA HTTP ${r.status}: ${String(body.errorMessage ?? 'request failed')}`);
      return body;
    } finally {
      clearTimeout(t);
    }
  }

  async pricing(instruments: string[]): Promise<OandaPrice[]> {
    const body = await this.get(`/v3/accounts/${encodeURIComponent(this.accountId)}/pricing?instruments=${instruments.map(encodeURIComponent).join(',')}`);
    const prices = (body.prices ?? []) as Record<string, unknown>[];
    return prices
      .map((p) => {
        const bids = ((p.bids ?? []) as { price: string; liquidity: number }[]).map((b) => ({ price: Number(b.price), liquidity: Number(b.liquidity) }));
        const asks = ((p.asks ?? []) as { price: string; liquidity: number }[]).map((a) => ({ price: Number(a.price), liquidity: Number(a.liquidity) }));
        return { instrument: String(p.instrument), time: Math.round(Number(p.time) * 1000), bid: bids[0]?.price ?? Number(p.closeoutBid), ask: asks[0]?.price ?? Number(p.closeoutAsk), tradeable: p.tradeable !== false, bids, asks };
      })
      .filter((p) => p.bid > 0 && p.ask > 0);
  }

  /** Closed mid-price candles (incomplete candles are dropped). */
  async candles(instrument: string, tf: Timeframe, count = 500): Promise<Candle[]> {
    const g = GRANULARITY[tf];
    if (!g) return [];
    const body = await this.get(`/v3/instruments/${encodeURIComponent(instrument)}/candles?granularity=${g}&count=${Math.min(count, 5000)}&price=M`);
    return ((body.candles ?? []) as { time: string; complete: boolean; volume: number; mid?: { o: string; h: string; l: string; c: string } }[])
      .filter((c) => c.complete && c.mid)
      .map((c) => ({ timestamp: Math.round(Number(c.time) * 1000), open: Number(c.mid!.o), high: Number(c.mid!.h), low: Number(c.mid!.l), close: Number(c.mid!.c), volume: Number(c.volume) }));
  }
}
