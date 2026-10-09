import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { useSocketEvent } from './useSocketEvent';
import type { Candle } from '../types';

/** Chart timeframes. 4h / 1D / 1W / 1M are calendar-aligned in UTC (weeks start Monday, months on the 1st). */
export const CHART_TFS = [
  { tf: '1m', label: '1m' },
  { tf: '5m', label: '5m' },
  { tf: '15m', label: '15m' },
  { tf: '1h', label: '1h' },
  { tf: '4h', label: '4h' },
  { tf: '1d', label: '1D' },
  { tf: '1w', label: '1W' },
  { tf: '1M', label: '1M' },
] as const;
export type ChartTf = (typeof CHART_TFS)[number]['tf'];

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const FIXED: Partial<Record<ChartTf, number>> = { '1m': MIN, '5m': 5 * MIN, '15m': 15 * MIN, '1h': H, '4h': 4 * H, '1d': D };

/** Start (ms, UTC) of the candle containing `ts` — must match the server's bucketing. */
export function bucketStart(ts: number, tf: ChartTf): number {
  const step = FIXED[tf];
  if (step) return Math.floor(ts / step) * step;
  if (tf === '1w') {
    const day = Math.floor(ts / D) * D;
    return day - ((new Date(day).getUTCDay() + 6) % 7) * D;
  }
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

type CandleEvent = Candle & { symbol: string; timeframe: string };
const strip = (c: Candle): Candle => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });

/**
 * Candles for a chart plus the forming candle, which moves on every price tick. Closed candles
 * from the server replace local ones; when a bucket rolls over locally, the finished candle is kept.
 */
export function useChartCandles(symbol: string, tf: ChartTf, tick: { last: number; timestamp: number } | undefined, limit = 500) {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [live, setLive] = useState<Candle | null>(null);
  const [loading, setLoading] = useState(true);
  const lastClose = useRef<number | undefined>(undefined);
  lastClose.current = candles[candles.length - 1]?.close;

  useEffect(() => {
    let alive = true;
    setCandles([]);
    setLive(null);
    setLoading(true);
    api<{ candles: Candle[]; forming?: Candle | null }>(`/market-data/candles?symbol=${encodeURIComponent(symbol)}&timeframe=${tf}&limit=${limit}`)
      .then((r) => {
        if (!alive) return;
        setCandles(r.candles);
        if (r.forming) setLive(strip(r.forming));
      })
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [symbol, tf, limit]);

  // Every tick moves the forming candle; a new bucket closes the previous one locally.
  useEffect(() => {
    if (!tick?.last) return;
    const bucket = bucketStart(tick.timestamp || Date.now(), tf);
    setLive((c) => {
      if (c && c.timestamp === bucket) {
        if (c.close === tick.last) return c;
        return { ...c, high: Math.max(c.high, tick.last), low: Math.min(c.low, tick.last), close: tick.last };
      }
      if (c && c.timestamp > bucket) return c; // stale tick
      if (c) setCandles((cs) => (cs.some((x) => x.timestamp === c.timestamp) ? cs : [...cs, c].slice(-1000)));
      const open = c?.close ?? lastClose.current ?? tick.last;
      return { timestamp: bucket, open, high: Math.max(open, tick.last), low: Math.min(open, tick.last), close: tick.last, volume: 0 };
    });
  }, [tick, tf]);

  useSocketEvent<CandleEvent>('candle', (c) => {
    if (c.symbol === symbol && c.timeframe === tf) setCandles((cs) => [...cs.filter((x) => x.timestamp !== c.timestamp), strip(c)].sort((a, b) => a.timestamp - b.timestamp).slice(-1000));
  });
  // The exchange's own forming candle (true OHLC + volume), merged with tick-level moves in between.
  useSocketEvent<CandleEvent>('candle-live', (c) => {
    if (c.symbol !== symbol || c.timeframe !== tf) return;
    setLive((cur) => {
      const base = strip(c);
      if (!cur || cur.timestamp !== c.timestamp) return base;
      return { ...base, high: Math.max(base.high, cur.high), low: Math.min(base.low, cur.low), close: c.close };
    });
  });

  return { candles, live, loading };
}
