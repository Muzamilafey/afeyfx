import { exchangeRegistry } from '../exchanges/registry';
import type { Candle } from '../types';
import { errorMessage, logger } from '../utils/logger';
import { CandleStore } from './CandleStore';
import { forexDataService } from './ForexDataService';
import { FOREX_VENUE, venueOf } from './instruments';
import { marketDataCache } from './MarketDataCache';
import { getMarketDataService } from './MarketDataService';

/**
 * Long chart timeframes (4 hours, 1 day, 1 week, 1 month). These are for charts only: the trading
 * engine keeps its own fixed timeframes. Buckets are calendar-aligned in UTC: 4h/1d from midnight,
 * weeks start on Monday 00:00, months on the 1st at 00:00 (the same alignment Binance uses).
 *
 * Sources, in order: the venue's own candles at that size (Binance via the exchange adapter, OANDA
 * H4/D/W/M); otherwise the platform's stored 1-hour candles aggregated into larger buckets. In
 * simulated mode older history is synthetic (as all simulated data is) and clearly labelled.
 */
export const CHART_TIMEFRAMES = ['4h', '1d', '1w', '1M'] as const;
export type ChartTimeframe = (typeof CHART_TIMEFRAMES)[number];
export const isChartTimeframe = (tf: string): tf is ChartTimeframe => (CHART_TIMEFRAMES as readonly string[]).includes(tf);

const H = 3_600_000;
const D = 24 * H;

/** Start (ms, UTC) of the bucket containing `ts`. */
export function bucketStart(ts: number, tf: ChartTimeframe): number {
  if (tf === '4h') return Math.floor(ts / (4 * H)) * 4 * H;
  if (tf === '1d') return Math.floor(ts / D) * D;
  if (tf === '1w') {
    const day = Math.floor(ts / D) * D;
    const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
    return day - dow * D;
  }
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** Start of the bucket after the one starting at `start`. */
export function nextBucket(start: number, tf: ChartTimeframe): number {
  if (tf === '4h') return start + 4 * H;
  if (tf === '1d') return start + D;
  if (tf === '1w') return start + 7 * D;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Aggregate ascending candles into calendar buckets. The last bucket may still be forming. */
export function aggregateCalendar(candles: Candle[], tf: ChartTimeframe): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of candles) {
    const b = bucketStart(c.timestamp, tf);
    if (!cur || cur.timestamp !== b) {
      if (cur) out.push(cur);
      cur = { timestamp: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface ChartCandles {
  candles: Candle[];
  /** The current, still-forming bucket (updated tick by tick on the client). */
  forming: Candle | null;
  source: 'exchange' | 'oanda' | 'aggregated' | 'simulated';
}

const OANDA_GRANULARITY: Record<ChartTimeframe, 'H4' | 'D' | 'W' | 'M'> = { '4h': 'H4', '1d': 'D', '1w': 'W', '1M': 'M' };

/** Split a series into closed candles + the forming one (the bucket containing `now`). */
function split(candles: Candle[], tf: ChartTimeframe, now = Date.now()): Pick<ChartCandles, 'candles' | 'forming'> {
  const current = bucketStart(now, tf);
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const last = sorted.at(-1);
  if (last && last.timestamp >= current) return { candles: sorted.slice(0, -1), forming: last };
  return { candles: sorted, forming: null };
}

/** Deterministic PRNG so the synthetic history is stable across requests. */
function seeded(seed: string) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

/**
 * Simulated mode only: extend the (synthetic) hourly history backwards with synthetic daily candles,
 * using the volatility of the recent hourly data, so weekly/monthly charts have something to show.
 */
function syntheticDailyBefore(symbol: string, first: Candle, hourly: Candle[], days: number): Candle[] {
  const rand = seeded(`${symbol}:daily`);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-12))) * Math.cos(2 * Math.PI * rand());
  const rets = hourly.slice(1).map((c, i) => Math.log(c.close / hourly[i].close)).filter(Number.isFinite);
  const hourlySd = rets.length > 10 ? Math.sqrt(rets.reduce((s, r) => s + r * r, 0) / rets.length) : 0.004;
  const dailySd = Math.min(0.08, Math.max(0.002, hourlySd * Math.sqrt(24)));
  const avgVol = hourly.length ? (hourly.reduce((s, c) => s + c.volume, 0) / hourly.length) * 24 : 0;
  const out: Candle[] = [];
  let close = first.open;
  let ts = Math.floor(first.timestamp / D) * D;
  for (let i = 0; i < days; i++) {
    ts -= D;
    const open = close * Math.exp(-dailySd * gauss());
    const high = Math.max(open, close) * (1 + Math.abs(gauss()) * dailySd * 0.4);
    const low = Math.min(open, close) * (1 - Math.abs(gauss()) * dailySd * 0.4);
    out.push({ timestamp: ts, open, high, low, close, volume: avgVol * (0.6 + rand() * 0.8) });
    close = open;
  }
  return out.reverse();
}

const cache = new Map<string, { at: number; value: ChartCandles }>();
const TTL_MS = 30_000;

export const chartCandleService = {
  clearCache() {
    cache.clear();
  },

  async get(symbol: string, tf: ChartTimeframe, limit = 300): Promise<ChartCandles> {
    limit = Math.max(10, Math.min(limit, 1000));
    const key = `${symbol}|${tf}|${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = await this.load(symbol, tf, limit);
    cache.set(key, { at: Date.now(), value });
    return value;
  },

  async load(symbol: string, tf: ChartTimeframe, limit: number): Promise<ChartCandles> {
    const venue = venueOf(symbol);
    const md = getMarketDataService();
    const simulated = md.simulated;

    // 1) The venue's own candles at this size.
    if (!simulated) {
      try {
        if (venue === FOREX_VENUE) {
          const rows = await forexDataService.chartCandles(symbol, OANDA_GRANULARITY[tf], limit + 1);
          if (rows?.length) return { ...split(rows.map(({ complete: _c, ...c }) => c), tf), source: 'oanda' };
        } else {
          const step = nextBucket(bucketStart(Date.now(), tf), tf) - bucketStart(Date.now(), tf);
          const since = bucketStart(Date.now() - (limit + 1) * step, tf);
          const rows = await exchangeRegistry.public(venue).getCandles(symbol, tf, since, limit + 1);
          if (rows.length) return { ...split(rows, tf), source: 'exchange' };
        }
      } catch (err) {
        logger.warn({ symbol, tf, err: errorMessage(err) }, 'Chart candles from the venue failed; aggregating stored candles');
      }
    }

    // 2) Aggregate the platform's own hourly candles (cache first, then the database).
    let hourly = marketDataCache.getCandles(venue, symbol, '1h');
    const stored = await CandleStore.latest(venue, symbol, '1h', 24 * 400).catch(() => [] as Candle[]);
    if (stored.length > hourly.length) {
      const byTs = new Map(stored.map((c) => [c.timestamp, c]));
      for (const c of hourly) byTs.set(c.timestamp, c);
      hourly = [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
    }
    // Include the forming hour so the current bucket reflects the latest price.
    const live = marketDataCache.getTicker(venue, symbol)?.data;
    const series = [...hourly];
    if (live?.last && series.length) {
      const hourTs = Math.floor(Date.now() / H) * H;
      const prev = series.at(-1)!;
      if (prev.timestamp < hourTs) series.push({ timestamp: hourTs, open: prev.close, high: Math.max(prev.close, live.last), low: Math.min(prev.close, live.last), close: live.last, volume: 0 });
    }
    if (simulated && series.length && tf !== '4h') {
      const span = tf === '1M' ? 31 * limit : tf === '1w' ? 7 * limit : tf === '1d' ? limit : Math.ceil(limit / 6);
      const have = (Date.now() - series[0].timestamp) / D;
      const missing = Math.min(3650, Math.ceil(span - have));
      if (missing > 0) series.unshift(...syntheticDailyBefore(symbol, series[0], hourly.slice(-500), missing));
    }
    const all = aggregateCalendar(series, tf);
    const { candles, forming } = split(all, tf);
    return { candles: candles.slice(-limit), forming, source: simulated ? 'simulated' : 'aggregated' };
  },
};
