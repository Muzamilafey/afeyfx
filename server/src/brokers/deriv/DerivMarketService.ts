import { AppError } from '../../utils/errors';
import type { BrokerConnectionDoc } from '../../models/BrokerConnection';
import { brokerRegistry } from '../services/BrokerRegistry';
import { BrokerError } from '../core/types';
import type { DerivConnectionAdapter } from './DerivConnectionAdapter';

/**
 * Deriv market data and contract offerings for one connected account, built only on read-only
 * Deriv calls (active_symbols, contracts_for, ticks_history, proposal, profit_table, statement).
 * Results come straight from Deriv; nothing is fabricated or filled in when Deriv returns no data.
 */

/** Deriv candle granularities (seconds) and the platform timeframe labels they correspond to. */
export const DERIV_GRANULARITIES: Record<string, number> = { '1m': 60, '2m': 120, '3m': 180, '5m': 300, '10m': 600, '15m': 900, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '8h': 28800, '1d': 86400 };

export interface DerivSymbol {
  symbol: string;
  name: string;
  market: string;
  marketName: string;
  submarket: string;
  pip: number;
  open: boolean;
  suspended: boolean;
}

export interface DerivOfferings {
  symbol: string;
  /** What AfeyFX can trade on this symbol for this account (from Deriv's contracts_for). */
  multiplier: { available: boolean; multipliers: number[]; minStake?: number; maxStake?: number };
  riseFall: { available: boolean; minDuration?: string; maxDuration?: string; durations: { unit: string; min: number; max: number }[] };
  /** Every contract category Deriv offers (including ones AfeyFX does not trade yet). */
  categories: { category: string; display: string; types: string[]; supportedInAfeyfx: boolean }[];
}

export interface DerivQuote {
  id: string;
  contractType: string;
  askPrice: number;
  payout: number | null;
  commission: number | null;
  spot: number | null;
  spotTime: number | null;
  longcode: string;
  limitOrder?: unknown;
  dateExpiry?: number | null;
  validUntil: number;
}

const cache = new Map<string, { at: number; v: unknown }>();
const cached = async <T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await load();
  cache.set(key, { at: Date.now(), v });
  return v;
};

/** Deriv duration strings: "1t", "15s", "1m", "1h", "1d" (min/max contract duration). */
function parseDuration(s?: string) {
  const m = /^(\d+)([tsmhd])$/.exec(String(s ?? ''));
  return m ? { n: Number(m[1]), unit: m[2] } : null;
}

export class DerivMarketService {
  async adapter(conn: BrokerConnectionDoc) {
    if (conn.provider !== 'deriv') throw new AppError(400, 'Not a Deriv connection');
    const a = (await brokerRegistry.get(conn)) as unknown as DerivConnectionAdapter;
    if (typeof a.query !== 'function') throw new AppError(500, 'Deriv adapter unavailable');
    return a;
  }

  clearCache() {
    cache.clear();
  }

  async symbols(conn: BrokerConnectionDoc): Promise<DerivSymbol[]> {
    return cached(`sym:${conn._id.toString()}`, 10 * 60_000, async () => {
      const r = await (await this.adapter(conn)).query({ active_symbols: 'brief' });
      return ((r.active_symbols ?? []) as Record<string, unknown>[])
        .map((s) => ({
          symbol: String(s.underlying_symbol ?? s.symbol ?? ''),
          name: String(s.display_name ?? s.underlying_symbol ?? s.symbol ?? ''),
          market: String(s.market ?? ''),
          marketName: String(s.market_display_name ?? s.market ?? ''),
          submarket: String(s.submarket_display_name ?? s.submarket ?? ''),
          pip: Number(s.pip ?? 0.01),
          open: s.exchange_is_open === 1 || s.exchange_is_open === true,
          suspended: s.is_trading_suspended === 1 || s.is_trading_suspended === true,
        }))
        .filter((s) => s.symbol)
        .sort((a, b) => a.marketName.localeCompare(b.marketName) || a.name.localeCompare(b.name));
    });
  }

  /** What this account may trade on a symbol, straight from Deriv's contracts_for. */
  async offerings(conn: BrokerConnectionDoc, symbol: string): Promise<DerivOfferings> {
    return cached(`off:${conn._id.toString()}:${symbol}`, 5 * 60_000, async () => {
      const r = await (await this.adapter(conn)).query({ contracts_for: symbol, currency: conn.currency ?? undefined });
      const avail = (((r.contracts_for as { available?: Record<string, unknown>[] } | undefined)?.available) ?? []) as Record<string, unknown>[];
      const byCat = new Map<string, { display: string; types: Set<string> }>();
      for (const c of avail) {
        const cat = String(c.contract_category ?? '');
        const e = byCat.get(cat) ?? { display: String(c.contract_category_display ?? cat), types: new Set<string>() };
        e.types.add(String(c.contract_type ?? ''));
        byCat.set(cat, e);
      }
      const mult = avail.filter((c) => /^MULT(UP|DOWN)$/.test(String(c.contract_type)));
      const rf = avail.filter((c) => /^(CALL|PUT)$/.test(String(c.contract_type)) && String(c.contract_category) === 'callput' && !c.barrier && String(c.barrier_category ?? 'euro_atm') === 'euro_atm');
      const multipliers = [...new Set(mult.flatMap((c) => ((c.multiplier_range as unknown[]) ?? []).map(Number)).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);
      const durations = new Map<string, { unit: string; min: number; max: number }>();
      for (const c of rf) {
        const lo = parseDuration(String(c.min_contract_duration));
        const hi = parseDuration(String(c.max_contract_duration));
        if (!lo || !hi) continue;
        const key = `${String(c.expiry_type)}`;
        durations.set(key, { unit: lo.unit === hi.unit ? lo.unit : `${lo.unit}-${hi.unit}`, min: lo.n, max: hi.n });
      }
      return {
        symbol,
        multiplier: { available: mult.length > 0, multipliers, minStake: mult[0]?.min_stake != null ? Number(mult[0].min_stake) : undefined, maxStake: mult[0]?.max_stake != null ? Number(mult[0].max_stake) : undefined },
        riseFall: { available: rf.length > 0, minDuration: rf[0] ? String(rf[0].min_contract_duration) : undefined, maxDuration: rf[0] ? String(rf[rf.length - 1].max_contract_duration) : undefined, durations: [...durations.values()] },
        categories: [...byCat.entries()].map(([category, e]) => ({ category, display: e.display, types: [...e.types], supportedInAfeyfx: category === 'multiplier' || category === 'callput' })),
      };
    });
  }

  async candles(conn: BrokerConnectionDoc, symbol: string, timeframe: string, count = 300) {
    const g = DERIV_GRANULARITIES[timeframe];
    if (!g) throw new AppError(400, 'Unsupported timeframe for Deriv candles');
    const a = await this.adapter(conn);
    const candles = await a.getCandles(symbol, g, Math.min(Math.max(count, 10), 5000));
    return { symbol, timeframe, granularity: g, candles, receivedAt: Date.now() };
  }

  /**
   * Older history for backtests: pages backwards with `end` (Deriv returns at most 5000 candles per
   * request). Stops when Deriv returns nothing older.
   */
  async history(conn: BrokerConnectionDoc, symbol: string, timeframe: string, count: number) {
    const g = DERIV_GRANULARITIES[timeframe];
    if (!g) throw new AppError(400, 'Unsupported timeframe for Deriv candles');
    const a = await this.adapter(conn);
    const want = Math.min(Math.max(count, 100), 30_000);
    const out = new Map<number, { timestamp: number; open: number; high: number; low: number; close: number; volume: number }>();
    let end: number | 'latest' = 'latest';
    for (let guard = 0; guard < 10 && out.size < want; guard++) {
      const r = await a.query({ ticks_history: symbol, style: 'candles', granularity: g, count: Math.min(5000, want - out.size), end });
      const page = ((r.candles ?? []) as { epoch: number; open: number; high: number; low: number; close: number }[]).map((c) => ({ timestamp: c.epoch * 1000, open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: 0 }));
      if (!page.length) break;
      const before = out.size;
      for (const c of page) out.set(c.timestamp, c);
      if (out.size === before) break;
      end = Math.floor(page[0].timestamp / 1000) - 1;
    }
    // Drop the still-forming candle: backtests use closed candles only.
    const now = Date.now();
    return [...out.values()].filter((c) => c.timestamp + g * 1000 <= now).sort((x, y) => x.timestamp - y.timestamp);
  }

  /**
   * Price quote for a contract (Deriv `proposal`). This does not buy anything; the quote expires
   * quickly and the actual purchase goes through the order pipeline and risk engine.
   */
  async quote(conn: BrokerConnectionDoc, q: { symbol: string; product: 'multiplier' | 'rise_fall'; side: 'buy' | 'sell'; stake: number; multiplier?: number; duration?: number; durationUnit?: string; stopLossAmount?: number; takeProfitAmount?: number }): Promise<DerivQuote> {
    const p: Record<string, unknown> = { proposal: 1, amount: Math.round(q.stake * 100) / 100, basis: 'stake', currency: conn.currency ?? 'USD', underlying_symbol: q.symbol };
    if (q.product === 'multiplier') {
      if (!q.multiplier) throw new AppError(400, 'Choose a multiplier');
      p.contract_type = q.side === 'buy' ? 'MULTUP' : 'MULTDOWN';
      p.multiplier = q.multiplier;
      const limit: Record<string, number> = {};
      if (q.stopLossAmount) limit.stop_loss = Math.round(q.stopLossAmount * 100) / 100;
      if (q.takeProfitAmount) limit.take_profit = Math.round(q.takeProfitAmount * 100) / 100;
      if (Object.keys(limit).length) p.limit_order = limit;
    } else {
      if (!q.duration || !q.durationUnit) throw new AppError(400, 'Choose a duration');
      p.contract_type = q.side === 'buy' ? 'CALL' : 'PUT';
      p.duration = q.duration;
      p.duration_unit = q.durationUnit;
    }
    let r;
    try {
      r = await (await this.adapter(conn)).query(p);
    } catch (err) {
      if (err instanceof BrokerError && err.definite) throw new AppError(422, err.message, 'DERIV_REJECTED');
      throw err;
    }
    const x = (r.proposal ?? {}) as Record<string, unknown>;
    if (!x.id) throw new AppError(502, 'Deriv returned no price', 'DERIV_NO_PRICE');
    return {
      id: String(x.id),
      contractType: String(p.contract_type),
      askPrice: Number(x.ask_price),
      payout: x.payout != null ? Number(x.payout) : null,
      commission: x.commission != null ? Number(x.commission) : null,
      spot: x.spot != null ? Number(x.spot) : null,
      spotTime: x.spot_time != null ? Number(x.spot_time) * 1000 : null,
      longcode: String(x.longcode ?? ''),
      limitOrder: x.limit_order,
      dateExpiry: x.date_expiry != null ? Number(x.date_expiry) * 1000 : null,
      validUntil: Date.now() + 10_000,
    };
  }

  /** Settled contracts with Deriv's own profit figures. */
  async profitTable(conn: BrokerConnectionDoc, limit = 50) {
    const r = await (await this.adapter(conn)).query({ profit_table: 1, description: 1, limit: Math.min(limit, 100), sort: 'DESC' });
    return (((r.profit_table as { transactions?: Record<string, unknown>[] } | undefined)?.transactions) ?? []).map((t) => ({
      contractId: String(t.contract_id ?? ''),
      contractType: String(t.contract_type ?? ''),
      symbol: String(t.underlying_symbol ?? t.shortcode ?? ''),
      buyPrice: Number(t.buy_price ?? 0),
      sellPrice: Number(t.sell_price ?? 0),
      profit: Number(t.sell_price ?? 0) - Number(t.buy_price ?? 0),
      purchaseTime: Number(t.purchase_time ?? 0) * 1000,
      sellTime: Number(t.sell_time ?? 0) * 1000,
      description: String(t.longcode ?? '').slice(0, 200),
    }));
  }
}

export const derivMarket = new DerivMarketService();
