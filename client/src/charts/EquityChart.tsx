import { useEffect, useRef } from 'react';
import { AreaSeries, createChart, type UTCTimestamp } from 'lightweight-charts';

export function EquityChart({ points, height = 220 }: { points: { t: number; equity: number }[]; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, { height, autoSize: true, layout: { background: { color: 'transparent' }, textColor: '#94a3b8' }, grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } }, timeScale: { timeVisible: true } });
    const s = c.addSeries(AreaSeries, { lineColor: '#38bdf8', topColor: 'rgba(56,189,248,0.3)', bottomColor: 'rgba(56,189,248,0)' });
    const seen = new Set<number>();
    const data = points
      .map((p) => ({ time: Math.floor(p.t / 1000) as UTCTimestamp, value: p.equity }))
      .filter((p) => (seen.has(p.time) ? false : (seen.add(p.time), true)))
      .sort((a, b) => a.time - b.time);
    s.setData(data);
    c.timeScale().fitContent();
    return () => c.remove();
  }, [points, height]);
  return <div ref={el} className="w-full" style={{ height }} />;
}
