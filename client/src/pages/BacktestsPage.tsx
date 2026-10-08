import { useEffect, useState } from 'react';
import { Badge, Card, Empty, ErrorText, statusColor } from '../components/ui';
import { MetricsTable } from '../components/MetricsTable';
import { EquityChart } from '../charts/EquityChart';
import { useApi } from '../hooks/useApi';
import { useAuth, canTrade, isAdmin } from '../hooks/useAuth';
import { api } from '../services/api';
import { fmtTime } from '../utils/format';
import type { Backtest, BacktestRun } from '../types';

const STRATS = ['trend-following', 'momentum', 'mean-reversion', 'breakout', 'vwap'];
const TFS = ['1m', '3m', '5m', '15m', '30m', '1h', '4h', '1d'];

export function BacktestsPage() {
  const { user } = useAuth();
  const list = useApi<{ backtests: Backtest[] }>('/backtests');
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useApi<{ backtest: Backtest; runs: BacktestRun[] }>(selected ? `/backtests/${selected}` : null, [selected]);
  const [form, setForm] = useState({ strategyKey: 'trend-following', symbol: 'BTC/USDT', timeframe: '1h', type: 'SIMPLE' as 'SIMPLE' | 'WALK_FORWARD', params: '{}', paramGrid: '{"adxMin":[20,25,30]}', feeRate: 0.001, slippagePct: 0.0005, spreadPct: 0.0005, startingBalance: 10000, trainBars: 1000, validationBars: 300, testBars: 300, minTrainTrades: 10 });
  const [error, setError] = useState<string | null>(null);
  const [importDays, setImportDays] = useState(365);
  const [info, setInfo] = useState<string | null>(null);

  // Backtests run asynchronously on the server; refresh while any run is in progress.
  const pending = list.data?.backtests.some((b) => b.runs.length === 0 || b.runs.some((r) => r.status === 'RUNNING' || r.status === 'QUEUED'));
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => {
      void list.reload();
      if (selected) void detail.reload();
    }, 3000);
    return () => clearInterval(t);
  }, [pending, selected, list, detail]);

  const submit = async () => {
    setError(null);
    try {
      const r = await api<{ backtest: Backtest }>('/backtests', {
        method: 'POST',
        body: {
          strategyKey: form.strategyKey,
          symbol: form.symbol,
          timeframe: form.timeframe,
          type: form.type,
          params: JSON.parse(form.params || '{}'),
          config: { feeRate: Number(form.feeRate), slippagePct: Number(form.slippagePct), spreadPct: Number(form.spreadPct), startingBalance: Number(form.startingBalance), trainBars: Number(form.trainBars), validationBars: Number(form.validationBars), testBars: Number(form.testBars), minTrainTrades: Number(form.minTrainTrades), paramGrid: JSON.parse(form.paramGrid || '{}') },
        },
      });
      setSelected(r.backtest._id);
      await list.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const oos = detail.data?.runs.find((r) => r.segment === 'OUT_OF_SAMPLE');
  const full = detail.data?.runs.find((r) => r.segment === 'FULL');
  const main = oos ?? full;

  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <div className="space-y-4">
        {canTrade(user) && (
          <Card title="New backtest">
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <label className="label">Strategy</label>
                <select className="input" value={form.strategyKey} onChange={set('strategyKey')}>{STRATS.map((s) => <option key={s}>{s}</option>)}</select>
              </div>
              <div><label className="label">Symbol</label><input className="input" value={form.symbol} onChange={set('symbol')} /></div>
              <div><label className="label">Timeframe</label><select className="input" value={form.timeframe} onChange={set('timeframe')}>{TFS.map((t) => <option key={t}>{t}</option>)}</select></div>
              <div className="col-span-2">
                <label className="label">Type</label>
                <select className="input" value={form.type} onChange={set('type')}>
                  <option value="SIMPLE">Simple (full period)</option>
                  <option value="WALK_FORWARD">Walk-forward (train → validation → out-of-sample → roll)</option>
                </select>
              </div>
              <div><label className="label">Fee rate</label><input className="input" type="number" step="0.0001" value={form.feeRate} onChange={set('feeRate')} /></div>
              <div><label className="label">Slippage</label><input className="input" type="number" step="0.0001" value={form.slippagePct} onChange={set('slippagePct')} /></div>
              <div><label className="label">Spread</label><input className="input" type="number" step="0.0001" value={form.spreadPct} onChange={set('spreadPct')} /></div>
              <div><label className="label">Starting balance</label><input className="input" type="number" value={form.startingBalance} onChange={set('startingBalance')} /></div>
              {form.type === 'SIMPLE' ? (
                <div className="col-span-2"><label className="label">Params (JSON)</label><input className="input font-mono text-xs" value={form.params} onChange={set('params')} /></div>
              ) : (
                <>
                  <div><label className="label">Train bars</label><input className="input" type="number" value={form.trainBars} onChange={set('trainBars')} /></div>
                  <div><label className="label">Validation bars</label><input className="input" type="number" value={form.validationBars} onChange={set('validationBars')} /></div>
                  <div><label className="label">OOS bars</label><input className="input" type="number" value={form.testBars} onChange={set('testBars')} /></div>
                  <div><label className="label">Min train trades</label><input className="input" type="number" value={form.minTrainTrades} onChange={set('minTrainTrades')} /></div>
                  <div className="col-span-2"><label className="label">Param grid (JSON)</label><input className="input font-mono text-xs" value={form.paramGrid} onChange={set('paramGrid')} /></div>
                </>
              )}
            </div>
            <ErrorText error={error} />
            <button className="btn-primary mt-3 w-full" onClick={submit}>Run backtest</button>
          </Card>
        )}
        {isAdmin(user) && (
          <Card title="Import history">
            <div className="flex gap-2">
              <input className="input" type="number" value={importDays} onChange={(e) => setImportDays(Number(e.target.value))} aria-label="days" />
              <button
                className="btn-ghost whitespace-nowrap"
                onClick={async () => {
                  setInfo('Importing…');
                  try {
                    const r = await api<{ inserted: number }>('/backtests/import-candles', { method: 'POST', body: { symbol: form.symbol, timeframe: form.timeframe, days: importDays } });
                    setInfo(`Inserted ${r.inserted} candles for ${form.symbol} ${form.timeframe}`);
                  } catch (e) {
                    setInfo((e as Error).message);
                  }
                }}
              >
                Import {form.symbol} {form.timeframe}
              </button>
            </div>
            {info && <div className="mt-2 text-xs text-slate-400">{info}</div>}
          </Card>
        )}
        <Card title="History">
          {list.data?.backtests.length ? (
            <div className="space-y-1">
              {list.data.backtests.map((b) => (
                <button key={b._id} onClick={() => setSelected(b._id)} className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-xs hover:bg-slate-800 ${selected === b._id ? 'bg-slate-800' : ''}`}>
                  <span>
                    <b>{b.strategyKey}</b> {b.symbol} {b.timeframe} <span className="text-slate-500">{b.type === 'WALK_FORWARD' ? 'WF' : ''}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    {b.runs.length ? <Badge color={statusColor(b.runs[b.runs.length - 1].status)}>{b.runs[b.runs.length - 1].status}</Badge> : <Badge color="amber">QUEUED</Badge>}
                    <span className="text-slate-500">{fmtTime(b.createdAt)}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <Empty>No backtests yet</Empty>
          )}
        </Card>
      </div>
      <div className="space-y-4 xl:col-span-2">
        {detail.data ? (
          <>
            <Card title={`${detail.data.backtest.strategyKey} · ${detail.data.backtest.symbol} · ${detail.data.backtest.timeframe} · ${main?.segment ?? ''}`}>
              {main?.status === 'FAILED' && <ErrorText error={main.error} />}
              {main?.warnings?.map((w) => (
                <div key={w} className="mb-1 rounded border border-amber-900 bg-amber-950/40 px-2 py-1 text-xs text-amber-300">⚠ {w}</div>
              ))}
              <div className="mb-2 text-[11px] text-slate-500">Results include fees, spread and slippage. A single backtest does not establish profitability — check out-of-sample and paper results.</div>
              {main?.metrics && <MetricsTable metrics={main.metrics} />}
              {main?.equityCurve && main.equityCurve.length > 1 && <div className="mt-3"><EquityChart points={main.equityCurve} /></div>}
            </Card>
            {detail.data.backtest.type === 'WALK_FORWARD' && (
              <Card title="Walk-forward windows">
                <table className="table">
                  <thead><tr><th>Window</th><th>Segment</th><th>Trades</th><th>Return</th><th>Max DD</th><th>Sharpe</th><th>Params</th></tr></thead>
                  <tbody>
                    {detail.data.runs.filter((r) => r.segment !== 'OUT_OF_SAMPLE').map((r) => (
                      <tr key={r._id}>
                        <td>{r.window}</td><td>{r.segment}</td><td>{r.metrics?.numberOfTrades}</td>
                        <td>{r.metrics ? `${(r.metrics.totalReturn * 100).toFixed(2)}%` : '—'}</td>
                        <td>{r.metrics ? `${(r.metrics.maxDrawdown * 100).toFixed(2)}%` : '—'}</td>
                        <td>{r.metrics?.sharpe?.toFixed(2) ?? 'n/a'}</td>
                        <td className="max-w-xs truncate">{JSON.stringify(r.params)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-2 text-[11px] text-slate-500">Parameters are selected on TRAIN, confirmed on VALIDATION, then frozen for the unseen OUT-OF-SAMPLE segment. Only the OOS aggregate (above) should be used to judge the strategy.</div>
              </Card>
            )}
          </>
        ) : (
          <Card><Empty>Select or run a backtest</Empty></Card>
        )}
      </div>
    </div>
  );
}
