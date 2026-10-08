import { useEffect, useRef } from 'react';
import { CandlestickSeries, HistogramSeries, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../types';
import { cssVar, useTheme } from '../hooks/useTheme';

export interface PriceMarker {
  price: number;
  color: string;
  title: string;
}

/**
 * Candlestick + volume chart (TradingView lightweight-charts), theme-aware.
 * `live` is the forming candle built from streaming ticks; `lines` draws e.g. position entries.
 */
export function CandleChart({ candles, live, lines = [], height = 320, fill = false }: { candles: Candle[]; live?: Candle | null; lines?: PriceMarker[]; height?: number; fill?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const vol = useRef<ISeriesApi<'Histogram'> | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const fitted = useRef(false);
  const { theme } = useTheme();

  useEffect(() => {
    if (!el.current) return;
    const text = cssVar('--color-slate-400', '#94a3b8');
    const grid = theme === 'light' ? '#e2e8f0' : '#1a2438';
    const c = createChart(el.current, {
      height: fill ? el.current.clientHeight || height : height,
      layout: { background: { color: 'transparent' }, textColor: text, fontFamily: 'ui-sans-serif, system-ui' },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      timeScale: { timeVisible: true, borderColor: grid, rightOffset: 8 },
      rightPriceScale: { borderColor: grid },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    series.current = c.addSeries(CandlestickSeries, { upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444', borderVisible: false, priceLineColor: '#0ea5e9', priceLineStyle: LineStyle.Dashed });
    vol.current = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    fitted.current = false;
    priceLines.current = [];
    return () => {
      c.remove();
      chart.current = null;
    };
  }, [height, theme, fill]);

  useEffect(() => {
    const t = (k: Candle) => Math.floor(k.timestamp / 1000) as UTCTimestamp;
    const all = live && (!candles.length || live.timestamp > candles[candles.length - 1].timestamp) ? [...candles, live] : candles;
    series.current?.setData(all.map((k) => ({ time: t(k), open: k.open, high: k.high, low: k.low, close: k.close })));
    vol.current?.setData(all.map((k) => ({ time: t(k), value: k.volume, color: k.close >= k.open ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)' })));
    if (!fitted.current && all.length) {
      chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, all.length - 120), to: all.length + 6 });
      fitted.current = true;
    }
  }, [candles, live, theme]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const pl of priceLines.current) s.removePriceLine(pl);
    priceLines.current = lines.map((l) => s.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true, title: l.title }));
  }, [lines, theme]);

  return <div ref={el} className="h-full w-full" style={fill ? undefined : { height }} />;
}
