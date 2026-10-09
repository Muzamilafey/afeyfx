import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type MouseEventParams,
  type SeriesMarker,
  type SeriesType,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Activity, ChartArea, ChartBarBig, ChartCandlestick, ChartLine, Download, LocateFixed, Minus, Pencil, Plus, Trash2 } from 'lucide-react';
import type { Candle } from '../types';
import { useTheme } from '../hooks/useTheme';

export type ChartType = 'area' | 'line' | 'candles' | 'bars';
export type IndicatorKey = 'sma20' | 'ema50' | 'bb20';
export interface TradeMarker {
  /** Entry time (ms). */
  time: number;
  price: number;
  side: 'buy' | 'sell';
  title: string;
}

const TYPES: { key: ChartType; label: string; icon: typeof ChartArea }[] = [
  { key: 'area', label: 'Area', icon: ChartArea },
  { key: 'line', label: 'Line', icon: ChartLine },
  { key: 'candles', label: 'Candles', icon: ChartCandlestick },
  { key: 'bars', label: 'OHLC bars', icon: ChartBarBig },
];
const INDICATORS: { key: IndicatorKey; label: string; color: string }[] = [
  { key: 'sma20', label: 'SMA 20', color: '#f59e0b' },
  { key: 'ema50', label: 'EMA 50', color: '#a855f7' },
  { key: 'bb20', label: 'Bollinger Bands (20, 2)', color: '#38bdf8' },
];

const sec = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp;
const load = <T,>(k: string, d: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : d;
  } catch {
    return d;
  }
};
const save = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* private mode */
  }
};

// ---------------------------------------------------------------- indicators (closed + forming bars)

function sma(v: number[], n: number) {
  const out: (number | null)[] = [];
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    out.push(i >= n - 1 ? s / n : null);
  }
  return out;
}
function ema(v: number[], n: number) {
  const out: (number | null)[] = [];
  const k = 2 / (n + 1);
  let e: number | null = null;
  for (let i = 0; i < v.length; i++) {
    if (i < n - 1) {
      out.push(null);
      continue;
    }
    e = e === null ? v.slice(0, n).reduce((a, b) => a + b, 0) / n : v[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}
function bollinger(v: number[], n: number, mult: number) {
  const mid = sma(v, n);
  const up: (number | null)[] = [];
  const lo: (number | null)[] = [];
  for (let i = 0; i < v.length; i++) {
    const m = mid[i];
    if (m === null) {
      up.push(null);
      lo.push(null);
      continue;
    }
    let sd = 0;
    for (let j = i - n + 1; j <= i; j++) sd += (v[j] - m) ** 2;
    sd = Math.sqrt(sd / n);
    up.push(m + mult * sd);
    lo.push(m - mult * sd);
  }
  return { mid, up, lo };
}

/** Bars with unique, ascending second timestamps (several ticks in one second keep the last). */
function normalize(bars: Candle[]) {
  const out: Candle[] = [];
  for (const b of bars) {
    const t = sec(b.timestamp);
    const last = out[out.length - 1];
    if (last && sec(last.timestamp) === t) out[out.length - 1] = { ...b, open: last.open, high: Math.max(last.high, b.high), low: Math.min(last.low, b.low) };
    else if (!last || sec(last.timestamp) < t) out.push(b);
  }
  return out;
}

interface Hover {
  x: number;
  price: number;
  changePct: number | null;
  time: number;
  ohlc?: Candle;
}

/**
 * Trading chart with Deriv-style controls: chart type (area, line, candles, OHLC bars), tick mode,
 * indicators (SMA, EMA, Bollinger), horizontal drawing lines, zoom in/out/reset, a crosshair
 * tooltip with price, change and time, entry markers for open trades and a PNG download.
 * Preferences and drawings are kept in this browser only.
 */
export function TradingChart({ candles, live, tickMode = false, precision, markers = [], drawKey }: { candles: Candle[]; live?: Candle | null; tickMode?: boolean; precision?: number; markers?: TradeMarker[]; drawKey: string }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const main = useRef<ISeriesApi<SeriesType> | null>(null);
  const vol = useRef<ISeriesApi<'Histogram'> | null>(null);
  const ind = useRef(new Map<IndicatorKey, ISeriesApi<'Line'>[]>());
  const markerApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const drawLines = useRef<IPriceLine[]>([]);
  const entryLines = useRef<IPriceLine[]>([]);
  const fitted = useRef(false);
  const { theme } = useTheme();

  const [type, setType] = useState<ChartType>(() => load('afx.chart.type', 'candles'));
  const [indicators, setIndicators] = useState<IndicatorKey[]>(() => load('afx.chart.ind', []));
  const [menu, setMenu] = useState<null | 'type' | 'ind'>(null);
  const [drawing, setDrawing] = useState(false);
  const [drawings, setDrawings] = useState<number[]>(() => load(`afx.draw.${drawKey}`, []));
  const [hover, setHover] = useState<Hover | null>(null);
  useEffect(() => setDrawings(load(`afx.draw.${drawKey}`, [])), [drawKey]);
  useEffect(() => save('afx.chart.type', type), [type]);
  useEffect(() => save('afx.chart.ind', indicators), [indicators]);
  useEffect(() => save(`afx.draw.${drawKey}`, drawings), [drawKey, drawings]);

  // Ticks are single prices: only area/line make sense there.
  const effType: ChartType = tickMode && (type === 'candles' || type === 'bars') ? 'area' : type;
  const bars = useMemo(() => normalize(live && (!candles.length || live.timestamp > candles[candles.length - 1].timestamp) ? [...candles, live] : candles), [candles, live]);
  const barsRef = useRef(bars);
  barsRef.current = bars;

  // ---- chart + series (rebuilt when the look changes)
  useEffect(() => {
    if (!el.current) return;
    const text = theme === 'light' ? '#475569' : '#94a3b8';
    const grid = theme === 'light' ? '#e2e8f0' : '#1a2438';
    const c = createChart(el.current, {
      layout: { background: { color: 'transparent' }, textColor: text, fontFamily: 'ui-sans-serif, system-ui' },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      timeScale: { timeVisible: true, secondsVisible: tickMode, borderColor: grid, rightOffset: 8 },
      rightPriceScale: { borderColor: grid },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    const priceFormat = precision !== undefined ? { type: 'price' as const, precision, minMove: 1 / 10 ** precision } : undefined;
    const common = { priceLineColor: '#0ea5e9', priceLineStyle: LineStyle.Dashed, ...(priceFormat ? { priceFormat } : {}) };
    main.current =
      effType === 'candles'
        ? c.addSeries(CandlestickSeries, { upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444', borderVisible: false, ...common })
        : effType === 'bars'
          ? c.addSeries(BarSeries, { upColor: '#22c55e', downColor: '#ef4444', thinBars: false, ...common })
          : effType === 'line'
            ? c.addSeries(LineSeries, { color: theme === 'light' ? '#0f172a' : '#e2e8f0', lineWidth: 2, ...common })
            : c.addSeries(AreaSeries, { lineColor: theme === 'light' ? '#0f172a' : '#e2e8f0', topColor: theme === 'light' ? 'rgba(15,23,42,0.18)' : 'rgba(226,232,240,0.16)', bottomColor: 'rgba(0,0,0,0)', lineWidth: 2, ...common });
    vol.current = tickMode ? null : c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    if (vol.current) c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    ind.current = new Map();
    markerApi.current = createSeriesMarkers(main.current, []);
    drawLines.current = [];
    entryLines.current = [];
    chart.current = c;
    fitted.current = false;

    const onMove = (p: MouseEventParams<Time>) => {
      if (!p.time || !p.point || !main.current) return setHover(null);
      const d = p.seriesData.get(main.current) as { value?: number; close?: number } | undefined;
      const price = d?.close ?? d?.value;
      if (price === undefined) return setHover(null);
      const all = barsRef.current;
      const i = all.findIndex((b) => sec(b.timestamp) === p.time);
      const prev = i > 0 ? all[i - 1].close : null;
      setHover({ x: p.point.x, price, changePct: prev ? (price - prev) / prev : null, time: Number(p.time) * 1000, ohlc: i >= 0 ? all[i] : undefined });
    };
    c.subscribeCrosshairMove(onMove);
    return () => {
      c.unsubscribeCrosshairMove(onMove);
      c.remove();
      chart.current = null;
      main.current = null;
    };
  }, [theme, effType, tickMode, precision]);

  // ---- data
  const shownBars = useRef(0);
  useEffect(() => {
    const s = main.current;
    if (!s) return;
    const ohlc = effType === 'candles' || effType === 'bars';
    s.setData(bars.map((b) => (ohlc ? { time: sec(b.timestamp), open: b.open, high: b.high, low: b.low, close: b.close } : { time: sec(b.timestamp), value: b.close })) as never);
    vol.current?.setData(bars.map((b) => ({ time: sec(b.timestamp), value: b.volume, color: b.close >= b.open ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)' })));
    if (!fitted.current && bars.length) {
      chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - (tickMode ? 80 : 120)), to: bars.length + 6 });
      fitted.current = true;
    }
    shownBars.current = bars.length;
  }, [bars, effType, tickMode, theme, precision]);

  // ---- indicators (series kept per indicator; data refreshed in place on every tick)
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const want = new Set(indicators);
    for (const [k, list] of ind.current) {
      if (!want.has(k)) {
        for (const s of list) c.removeSeries(s);
        ind.current.delete(k);
      }
    }
    const closes = bars.map((b) => b.close);
    const times = bars.map((b) => sec(b.timestamp));
    const line = (color: string, style = LineStyle.Solid) => c.addSeries(LineSeries, { color, lineWidth: 1, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const put = (s: ISeriesApi<'Line'>, vals: (number | null)[]) => s.setData(vals.flatMap((v, i) => (v === null ? [] : [{ time: times[i], value: v }])));
    for (const k of indicators) {
      let list = ind.current.get(k);
      if (!list) {
        list = k === 'bb20' ? [line('#38bdf8', LineStyle.Dashed), line('#38bdf8', LineStyle.Dotted), line('#38bdf8', LineStyle.Dashed)] : [line(k === 'sma20' ? '#f59e0b' : '#a855f7')];
        ind.current.set(k, list);
      }
      if (k === 'sma20') put(list[0], sma(closes, 20));
      else if (k === 'ema50') put(list[0], ema(closes, 50));
      else {
        const b = bollinger(closes, 20, 2);
        put(list[0], b.up);
        put(list[1], b.mid);
        put(list[2], b.lo);
      }
    }
  }, [bars, indicators, effType, tickMode, theme, precision]);

  // ---- trade entries: arrow at the entry bar + entry price line (like Deriv's entry spot)
  useEffect(() => {
    const s = main.current;
    if (!s || !markerApi.current) return;
    const times = bars.map((b) => sec(b.timestamp));
    const snap = (t: number) => {
      const target = sec(t);
      let best: UTCTimestamp | null = null;
      for (const x of times) if (x <= target) best = x;
      return best;
    };
    const ms: SeriesMarker<Time>[] = markers.flatMap((m) => {
      const t = snap(m.time);
      return t === null ? [] : [{ time: t, position: m.side === 'buy' ? 'belowBar' : 'aboveBar', color: m.side === 'buy' ? '#22c55e' : '#ef4444', shape: m.side === 'buy' ? 'arrowUp' : 'arrowDown', text: m.title } as SeriesMarker<Time>];
    });
    markerApi.current.setMarkers(ms.sort((a, b) => Number(a.time) - Number(b.time)));
    for (const l of entryLines.current) s.removePriceLine(l);
    entryLines.current = markers.map((m) => s.createPriceLine({ price: m.price, color: m.side === 'buy' ? '#22c55e' : '#ef4444', lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: m.title }));
  }, [markers, bars, effType, tickMode, theme, precision]);

  // ---- horizontal drawing lines
  useEffect(() => {
    const s = main.current;
    if (!s) return;
    for (const l of drawLines.current) s.removePriceLine(l);
    drawLines.current = drawings.map((p) => s.createPriceLine({ price: p, color: '#f59e0b', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' }));
  }, [drawings, effType, tickMode, theme, precision]);
  useEffect(() => {
    const c = chart.current;
    if (!c || !drawing) return;
    const onClick = (p: MouseEventParams<Time>) => {
      if (!p.point || !main.current) return;
      const price = main.current.coordinateToPrice(p.point.y);
      if (price === null) return;
      setDrawings((d) => [...d, Number(price)].slice(-20));
      setDrawing(false);
    };
    c.subscribeClick(onClick);
    return () => c.unsubscribeClick(onClick);
  }, [drawing, effType, tickMode, theme, precision]);

  // ---- zoom / reset / download
  const zoom = (factor: number) => {
    const ts = chart.current?.timeScale();
    const r = ts?.getVisibleLogicalRange();
    if (!ts || !r) return;
    const width = Math.max(10, (r.to - r.from) * factor);
    ts.setVisibleLogicalRange({ from: r.to - width, to: r.to });
  };
  const reset = () => {
    const n = shownBars.current;
    chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - (tickMode ? 80 : 120)), to: n + 6 });
    chart.current?.priceScale('right').applyOptions({ autoScale: true });
  };
  const download = () => {
    const canvas = chart.current?.takeScreenshot();
    if (!canvas) return;
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = `afeyfx-chart-${drawKey.replace(/[^A-Za-z0-9]/g, '')}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    a.click();
  };

  const dp = precision ?? 5;
  const TypeIcon = TYPES.find((t) => t.key === effType)!.icon;
  const btn = 'flex h-10 w-10 items-center justify-center rounded-full bg-slate-900/90 text-slate-300 ring-1 ring-slate-800 hover:bg-slate-800 hover:text-white';
  return (
    <div className="relative h-full w-full">
      <div ref={el} className={`h-full w-full ${drawing ? 'cursor-crosshair' : ''}`} />

      {/* crosshair tooltip (price, change vs previous bar, time) */}
      {hover && (
        <div className="pointer-events-none absolute top-2 z-10 -translate-x-1/2 overflow-hidden rounded-md text-center text-xs shadow-lg ring-1 ring-slate-700" style={{ left: Math.min(Math.max(hover.x, 80), (el.current?.clientWidth ?? 400) - 80) }}>
          {hover.changePct !== null && <div className={`px-3 py-0.5 font-bold text-white ${hover.changePct >= 0 ? 'bg-emerald-500' : 'bg-red-500'}`}>{(hover.changePct * 100).toFixed(5)}%</div>}
          <div className="bg-slate-900/95 px-3 py-1">
            <div className="font-mono text-sm font-semibold text-slate-50">{hover.price.toFixed(dp)}</div>
            {hover.ohlc && !tickMode && (effType === 'candles' || effType === 'bars') && (
              <div className="font-mono text-[10px] text-slate-400">
                O {hover.ohlc.open.toFixed(dp)} H {hover.ohlc.high.toFixed(dp)} L {hover.ohlc.low.toFixed(dp)}
              </div>
            )}
            <div className="text-[10px] text-slate-400">{new Date(hover.time).toLocaleString(undefined, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div>
          </div>
        </div>
      )}

      {/* left toolbar */}
      <div className="absolute bottom-16 left-3 z-20 flex flex-col gap-2">
        <div className="relative">
          <button className={btn} title="Chart type" aria-label="Chart type" onClick={() => setMenu(menu === 'type' ? null : 'type')}>
            <TypeIcon size={18} />
          </button>
          {tickMode && <span className="pointer-events-none absolute -top-2 -right-1 rounded bg-slate-700 px-1 text-[9px] font-bold text-white">1t</span>}
          {menu === 'type' && (
            <div className="absolute bottom-0 left-12 w-44 rounded-lg bg-slate-900 p-1 shadow-xl ring-1 ring-slate-700">
              {TYPES.map((t) => {
                const disabled = tickMode && (t.key === 'candles' || t.key === 'bars');
                return (
                  <button key={t.key} disabled={disabled} onClick={() => (setType(t.key), setMenu(null))} className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${effType === t.key ? 'bg-sky-600 text-white' : 'text-slate-300 hover:bg-slate-800'} disabled:opacity-40`} title={disabled ? 'Not available for ticks' : undefined}>
                    <t.icon size={14} /> {t.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="relative">
          <button className={`${btn} ${indicators.length ? '!text-sky-400' : ''}`} title="Indicators" aria-label="Indicators" onClick={() => setMenu(menu === 'ind' ? null : 'ind')}>
            <Activity size={18} />
          </button>
          {menu === 'ind' && (
            <div className="absolute bottom-0 left-12 w-56 rounded-lg bg-slate-900 p-2 shadow-xl ring-1 ring-slate-700">
              {INDICATORS.map((i) => (
                <label key={i.key} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-slate-300 hover:bg-slate-800">
                  <input type="checkbox" checked={indicators.includes(i.key)} onChange={(e) => setIndicators((cur) => (e.target.checked ? [...cur, i.key] : cur.filter((x) => x !== i.key)))} />
                  <span className="h-2 w-3 rounded-sm" style={{ background: i.color }} /> {i.label}
                </label>
              ))}
            </div>
          )}
        </div>
        <button className={`${btn} ${drawing ? '!bg-amber-500 !text-slate-950' : ''}`} title={drawing ? 'Click on the chart to place a line' : 'Draw a horizontal line'} aria-label="Draw horizontal line" onClick={() => (setDrawing(!drawing), setMenu(null))}>
          <Pencil size={17} />
        </button>
        {drawings.length > 0 && (
          <button className={btn} title="Remove drawings" aria-label="Remove drawings" onClick={() => setDrawings([])}>
            <Trash2 size={17} />
          </button>
        )}
        <button className={btn} title="Download chart image" aria-label="Download chart image" onClick={download}>
          <Download size={17} />
        </button>
      </div>

      {/* zoom controls */}
      <div className="absolute bottom-10 left-1/2 z-20 flex -translate-x-1/2 gap-2">
        <button className={btn} title="Zoom out" aria-label="Zoom out" onClick={() => zoom(1.4)}>
          <Minus size={18} />
        </button>
        <button className={btn} title="Back to now" aria-label="Reset view" onClick={reset}>
          <LocateFixed size={18} />
        </button>
        <button className={btn} title="Zoom in" aria-label="Zoom in" onClick={() => zoom(0.7)}>
          <Plus size={18} />
        </button>
      </div>
      {drawing && <div className="absolute top-2 left-1/2 z-20 -translate-x-1/2 rounded bg-amber-500 px-2 py-1 text-xs font-semibold text-slate-950">Click on the chart to place a line</div>}
    </div>
  );
}
