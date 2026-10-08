import { useEffect, useRef } from 'react';
import { AreaSeries, createChart, type UTCTimestamp } from 'lightweight-charts';
import { cssVar, useTheme } from '../hooks/useTheme';

export function EquityChart({ points, height = 220 }: { points: { t: number; equity: number }[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  useEffect(() => {
    if (!el.current) return;
    const grid = theme === 'light' ? '#e2e8f0' : '#1a2438';
    const c = createChart(el.current, { height, autoSize: true, layout: { background: { color: 'transparent' }, textColor: cssVar('--color-slate-400', '#94a3b8') }, grid: { vertLines: { color: grid }, horzLines: { color: grid } }, timeScale: { timeVisible: true } });
    const s = c.addSeries(AreaSeries, { lineColor: '#0ea5e9', topColor: 'rgba(14,165,233,0.3)', bottomColor: 'rgba(14,165,233,0)' });
    const seen = new Set<number>();
    const data = points
      .map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.equity }))
      .filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true)))
      .sort((a, b) => a.time - b.time);
    s.setData(data);
    c.timeScale().fitContent();
    return () => c.remove();
  }, [points, height, theme]);
  return <div ref={el} className="w-full" style={{ height }} />;
}
