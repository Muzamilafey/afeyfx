import { useEffect, useRef } from 'react';
import { CandlestickSeries, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../types';

/** Candlestick + volume chart (TradingView lightweight-charts). New closed candles are appended live. */
export function CandleChart({ candles, height = 320 }: { candles: Candle[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const vol = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      height,
      layout: { background: { color: 'transparent' }, textColor: '#94a3b8' },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      timeScale: { timeVisible: true, borderColor: '#334155' },
      rightPriceScale: { borderColor: '#334155' },
      autoSize: true,
    });
    series.current = c.addSeries(CandlestickSeries, { upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444', borderVisible: false });
    vol.current = c.addSeries(HistogramSeries, { priceScaleId: 'vol', color: '#334155', priceFormat: { type: 'volume' } });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.current = c;
    return () => c.remove();
  }, [height]);

  useEffect(() => {
    const data = candles.map((k) => ({ time: Math.floor(k.timestamp / 1000) as UTCTimestamp, open: k.open, high: k.high, low: k.low, close: k.close }));
    series.current?.setData(data);
    vol.current?.setData(candles.map((k) => ({ time: Math.floor(k.timestamp / 1000) as UTCTimestamp, value: k.volume, color: k.close >= k.open ? '#14532d' : '#7f1d1d' })));
  }, [candles]);

  return <div ref={el} className="w-full" style={{ height }} />;
}
