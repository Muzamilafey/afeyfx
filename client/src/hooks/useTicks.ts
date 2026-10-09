import { useEffect, useState } from 'react';
import { api } from '../services/api';
import type { Candle } from '../types';

const point = (timestamp: number, price: number): Candle => ({ timestamp, open: price, high: price, low: price, close: price, volume: 0 });

/** Tick chart data: recent ticks from the server, then every streamed price tick appended. */
export function useTicks(symbol: string, tick: { last: number; timestamp: number } | undefined, enabled: boolean, max = 600) {
  const [ticks, setTicks] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setTicks([]);
    setLoading(true);
    api<{ ticks: { timestamp: number; price: number }[] }>(`/market-data/ticks?symbol=${encodeURIComponent(symbol)}&limit=300`)
      .then((r) => alive && setTicks((cur) => [...r.ticks.map((t) => point(t.timestamp, t.price)), ...cur.filter((c) => c.timestamp > (r.ticks.at(-1)?.timestamp ?? 0))]))
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [symbol, enabled]);

  useEffect(() => {
    if (!enabled || !tick?.last) return;
    const ts = tick.timestamp || Date.now();
    setTicks((cur) => {
      const last = cur[cur.length - 1];
      if (last && (ts < last.timestamp || (ts === last.timestamp && last.close === tick.last))) return cur;
      return [...cur, point(ts, tick.last)].slice(-max);
    });
  }, [tick, enabled, max]);

  return { ticks, loading };
}
