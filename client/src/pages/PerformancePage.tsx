import { useState } from 'react';
import { Card, Empty, Tabs } from '../components/ui';
import { MetricsTable } from '../components/MetricsTable';
import { EquityChart } from '../charts/EquityChart';
import { useApi } from '../hooks/useApi';
import type { Metrics } from '../types';

interface Report {
  disclaimer: string;
  strategies: { strategyKey: string; backtest: { metrics: Metrics } | null; outOfSample: { metrics: Metrics } | null; paper: Metrics | null; live: Metrics | null }[];
}

const GROUPS = ['strategyKey', 'symbol', 'timeframe'] as const;

export function PerformancePage() {
  const report = useApi<Report>('/portfolio/report');
  const [mode, setMode] = useState<'PAPER' | 'LIVE'>('PAPER');
  const [group, setGroup] = useState<(typeof GROUPS)[number]>('strategyKey');
  const perf = useApi<{ overall: Metrics; groups: Record<string, Metrics> }>(`/portfolio/performance?mode=${mode}&groupBy=${group}`, [mode, group]);
  const snaps = useApi<{ snapshots: { timestamp: string; equity: number }[] }>(`/portfolio/snapshots?mode=${mode}&days=90`, [mode]);

  return (
    <div className="space-y-4">
      <Card title="Profitability report — reported separately, never blended">
        <div className="mb-3 rounded border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">{report.data?.disclaimer ?? 'Past performance does not guarantee future results.'}</div>
        {report.data?.strategies.length ? (
          <div className="space-y-4">
            {report.data.strategies.map((s) => (
              <div key={s.strategyKey}>
                <div className="mb-2 font-semibold">{s.strategyKey}</div>
                <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-4">
                  {([['Backtest (in-sample)', s.backtest?.metrics], ['Out-of-sample', s.outOfSample?.metrics], ['Paper', s.paper], ['Live', s.live]] as const).map(([label, m]) => (
                    <div key={label} className="rounded-lg border border-slate-800 p-2">
                      <div className="mb-2 text-xs font-semibold text-slate-400 uppercase">{label}</div>
                      {m ? <MetricsTable metrics={m} compact /> : <Empty>No data</Empty>}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty>No results yet</Empty>
        )}
      </Card>
      <Card
        title="Portfolio performance"
        actions={
          <div className="flex gap-1">
            {(['PAPER', 'LIVE'] as const).map((m) => (
              <button key={m} className={`rounded px-2 py-0.5 text-xs ${mode === m ? 'bg-sky-700' : 'bg-slate-800 text-slate-400'}`} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>
        }
      >
        {perf.data && <MetricsTable metrics={perf.data.overall} />}
        {snaps.data && snaps.data.snapshots.length > 1 && <div className="mt-3"><EquityChart points={snaps.data.snapshots.map((s) => ({ t: new Date(s.timestamp).getTime(), equity: s.equity }))} /></div>}
        <div className="mt-4">
          <Tabs tabs={GROUPS} value={group} onChange={setGroup} />
          {perf.data && Object.keys(perf.data.groups).length ? (
            <div className="space-y-3">
              {Object.entries(perf.data.groups).map(([k, m]) => (
                <div key={k}>
                  <div className="mb-1 text-sm font-semibold">{k}</div>
                  <MetricsTable metrics={m} />
                </div>
              ))}
            </div>
          ) : (
            <Empty>No trades in {mode}</Empty>
          )}
        </div>
      </Card>
    </div>
  );
}
