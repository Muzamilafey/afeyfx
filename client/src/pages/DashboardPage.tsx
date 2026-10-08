import { useMemo, useState } from 'react';
import { Badge, Card, Empty, ErrorText, Stat, signalColor } from '../components/ui';
import { CandleChart } from '../charts/CandleChart';
import { useApi } from '../hooks/useApi';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { useAuth, canTrade } from '../hooks/useAuth';
import { useTradingStatus } from '../hooks/useTradingStatus';
import { api } from '../services/api';
import { fmtNum, fmtPct, fmtPrice, fmtSigned, fmtTime, pnlClass } from '../utils/format';
import type { AIAnalysis, Candle, MarketSummary, Portfolio, Position, RiskStatus, Signal, Trade } from '../types';

interface MarketAnalysisResp {
  regime: { regime: string; reason: string };
}

export function DashboardPage() {
  const { user } = useAuth();
  const { settings } = useTradingStatus();
  const mode = settings?.mode ?? 'PAPER';

  const portfolio = useApi<{ portfolio: Portfolio }>(`/portfolio?mode=${mode}`, [mode]);
  const markets = useApi<{ markets: MarketSummary[] }>('/market-data/summary');
  const positions = useApi<{ positions: Position[] }>(`/positions?mode=${mode}`, [mode]);
  const trades = useApi<{ trades: Trade[] }>(`/trades?mode=${mode}&limit=15`, [mode]);
  const risk = useApi<RiskStatus>('/risk');
  const analyses = useApi<{ analyses: AIAnalysis[] }>('/ai/analyses?kind=MARKET&limit=5');
  const signals = useApi<{ signals: Signal[] }>(`/signals?mode=${mode}&limit=10`, [mode]);

  const symbols = markets.data?.markets.map((m) => m.symbol) ?? [];
  const [symbol, setSymbol] = useState<string>('');
  const [tf, setTf] = useState('1h');
  const active = symbol || symbols[0] || 'BTC/USDT';
  const candles = useApi<{ candles: Candle[] }>(`/market-data/candles?symbol=${encodeURIComponent(active)}&timeframe=${tf}&limit=300`, [active, tf]);
  const analysis = useApi<MarketAnalysisResp>(`/market-data/analysis?symbol=${encodeURIComponent(active)}&timeframe=${tf}`, [active, tf]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  // ---- real-time updates (no polling) ----
  useSocketEvent<{ symbol: string; last: number; bid: number; ask: number; change24hPct?: number }>('price', (p) => {
    markets.setData((d) => (d ? { markets: d.markets.map((m) => (m.symbol === p.symbol ? { ...m, price: p.last ?? m.price, bid: p.bid, ask: p.ask, spreadPct: (p.ask - p.bid) / ((p.ask + p.bid) / 2), change24hPct: p.change24hPct ?? m.change24hPct, dataAgeMs: 0 } : m)) } : d));
  });
  useSocketEvent<Portfolio>('portfolio', (p) => {
    if (p.mode === mode) portfolio.setData({ portfolio: p });
  });
  useSocketEvent('position', () => void positions.reload());
  useSocketEvent<Trade>('trade', (t) => {
    if (t.mode === mode) trades.setData((d) => ({ trades: [t, ...(d?.trades ?? [])].slice(0, 15) }));
  });
  useSocketEvent<AIAnalysis>('ai-analysis', (a) => analyses.setData((d) => ({ analyses: [a, ...(d?.analyses ?? [])].slice(0, 5) })));
  useSocketEvent<Signal>('signal', () => void signals.reload());
  useSocketEvent('risk', () => void risk.reload());
  useSocketEvent<Candle & { symbol: string; timeframe: string }>('candle', (c) => {
    if (c.symbol === active && c.timeframe === tf) candles.setData((d) => ({ candles: [...(d?.candles ?? []).filter((x) => x.timestamp !== c.timestamp), c].slice(-300) }));
  });

  const p = portfolio.data?.portfolio;
  const r = risk.data;
  const regimeBySymbol = useMemo(() => ({ [active]: analysis.data?.regime }), [active, analysis.data]);

  const runAi = async () => {
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await api<{ status: string; error?: string }>('/ai/analyze', { method: 'POST', body: { symbol: active, timeframe: tf } });
      if (res.status !== 'OK') setAiError(`AI ${res.status}: ${res.error ?? ''}`);
      await analyses.reload();
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ACCOUNT */}
      <Card title={`Account · ${mode}`}>
        <ErrorText error={portfolio.error} />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          <Stat label="Balance" value={fmtNum(p?.balance)} sub={p?.baseCurrency} />
          <Stat label="Equity" value={fmtNum(p?.equity)} />
          <Stat label="Available" value={fmtNum(p?.available)} />
          <Stat label="Daily P&L" value={fmtSigned(p?.dailyPnl)} valueClass={pnlClass(p?.dailyPnl)} sub={fmtPct(p?.dailyPnlPct)} />
          <Stat label="Total P&L" value={fmtSigned(p?.totalPnl)} valueClass={pnlClass(p?.totalPnl)} sub={`fees ${fmtNum(p?.fees)}`} />
          <Stat label="Unrealized" value={fmtSigned(p?.unrealizedPnl)} valueClass={pnlClass(p?.unrealizedPnl)} />
          <Stat label="Drawdown" value={fmtPct(p?.drawdown)} valueClass={p && p.drawdown > 0.05 ? 'text-red-400' : ''} />
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* MARKET */}
        <Card title="Markets" className="xl:col-span-1">
          {markets.data?.markets.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Price</th>
                  <th>24h</th>
                  <th>Vol (24h)</th>
                  <th>Volatility</th>
                </tr>
              </thead>
              <tbody>
                {markets.data.markets.map((m) => (
                  <tr key={m.symbol} onClick={() => setSymbol(m.symbol)} className={`cursor-pointer hover:bg-slate-800/50 ${m.symbol === active ? 'bg-slate-800/40' : ''}`}>
                    <td className="font-sans font-semibold">
                      {m.symbol} {m.dataAgeMs > 30_000 && <Badge color="red">STALE</Badge>}
                    </td>
                    <td>{fmtPrice(m.price)}</td>
                    <td className={pnlClass(m.change24hPct)}>{fmtPct(m.change24hPct)}</td>
                    <td>{fmtNum(m.volume24h, 0)}</td>
                    <td>{fmtPct(m.volatility, 3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>{markets.error ?? 'Waiting for market data…'}</Empty>
          )}
          <div className="mt-3 text-xs text-slate-400">
            {active}: trend/regime <Badge color="blue">{regimeBySymbol[active]?.regime ?? '—'}</Badge>
            <div className="mt-1 text-slate-500">{regimeBySymbol[active]?.reason}</div>
          </div>
        </Card>

        <Card
          title={`${active} · ${tf}`}
          className="xl:col-span-2"
          actions={
            <div className="flex gap-1">
              {['5m', '15m', '1h', '4h'].map((t) => (
                <button key={t} className={`rounded px-2 py-0.5 text-xs ${t === tf ? 'bg-sky-700 text-white' : 'text-slate-400 hover:bg-slate-800'}`} onClick={() => setTf(t)}>
                  {t}
                </button>
              ))}
            </div>
          }
        >
          {candles.data?.candles.length ? <CandleChart candles={candles.data.candles} /> : <Empty>No candles for this timeframe yet</Empty>}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* POSITIONS */}
        <Card title={`Open positions (${positions.data?.positions.length ?? 0})`} className="xl:col-span-2">
          {positions.data?.positions.length ? (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Dir</th>
                    <th>Size</th>
                    <th>Entry</th>
                    <th>Current</th>
                    <th>Stop</th>
                    <th>Target</th>
                    <th>P&L</th>
                    <th>Strategy</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {positions.data.positions.map((x) => (
                    <tr key={x._id}>
                      <td className="font-sans font-semibold">{x.symbol}</td>
                      <td>
                        <Badge color={signalColor(x.direction)}>{x.direction}</Badge>
                      </td>
                      <td>{fmtNum(x.amount, 6)}</td>
                      <td>{fmtPrice(x.entryPrice)}</td>
                      <td>{fmtPrice(x.currentPrice)}</td>
                      <td className="text-red-300">{fmtPrice(x.stopLoss)}</td>
                      <td className="text-emerald-300">{fmtPrice(x.takeProfit)}</td>
                      <td className={pnlClass(x.unrealizedPnl)}>{fmtSigned(x.unrealizedPnl)}</td>
                      <td>{x.strategyKey ?? 'manual'}</td>
                      <td>
                        {canTrade(user) && (mode === 'PAPER' || user?.role === 'admin') && (
                          <button
                            className="btn-ghost !px-2 !py-0.5 text-xs"
                            onClick={async () => {
                              if (!confirm(`Close ${x.symbol} ${x.direction} at market?`)) return;
                              await api(`/positions/${x._id}/close`, { method: 'POST' }).catch((e) => alert((e as Error).message));
                              void positions.reload();
                            }}
                          >
                            Close
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No open positions</Empty>
          )}
        </Card>

        {/* RISK */}
        <Card title="Risk">
          {r ? (
            <div className="space-y-2 text-sm">
              <Row label="Risk per trade" value={fmtPct(r.riskPerTrade)} />
              <Row label="Daily loss" value={`${fmtPct(r.dailyLoss.pct)} / ${fmtPct(r.dailyLoss.max)}`} warn={r.dailyLoss.pct >= r.dailyLoss.max * 0.5} />
              <Row label="Weekly loss" value={`${fmtPct(r.weeklyLoss.pct)} / ${fmtPct(r.weeklyLoss.max)}`} warn={r.weeklyLoss.pct >= r.weeklyLoss.max * 0.5} />
              <Row label="Exposure" value={`${fmtPct(r.exposure.pct)} / ${fmtPct(r.exposure.max)}`} warn={r.exposure.pct >= r.exposure.max * 0.8} />
              <Row label="Open positions" value={`${r.openPositions.count} / ${r.openPositions.max}`} />
              <div className="flex items-center justify-between">
                <span className="text-slate-400">Circuit breaker</span>
                {r.circuitBreaker.open ? <Badge color="red">OPEN — no new trades</Badge> : <Badge color="green">CLOSED</Badge>}
              </div>
              {r.circuitBreaker.trips.map((t) => (
                <div key={t.code} className="rounded border border-red-900/60 bg-red-950/30 px-2 py-1 text-xs text-red-300">
                  <b>{t.code}</b>: {t.message}
                </div>
              ))}
              {!r.tradingEnabled && <Badge color="amber">New trades stopped</Badge>}
            </div>
          ) : (
            <Empty />
          )}
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* TRADES */}
        <Card title="Recent trades" className="xl:col-span-2">
          {trades.data?.trades.length ? (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Closed</th>
                    <th>Symbol</th>
                    <th>Strategy</th>
                    <th>Dir</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Fees</th>
                    <th>Net P&L</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.data.trades.map((t) => (
                    <tr key={t._id}>
                      <td>{fmtTime(t.closedAt)}</td>
                      <td className="font-sans">{t.symbol}</td>
                      <td>{t.strategyKey ?? '—'}</td>
                      <td>
                        <Badge color={signalColor(t.direction)}>{t.direction}</Badge>
                      </td>
                      <td>{fmtPrice(t.entryPrice)}</td>
                      <td>{fmtPrice(t.exitPrice)}</td>
                      <td>{fmtNum(t.fees)}</td>
                      <td className={pnlClass(t.netPnl)}>{fmtSigned(t.netPnl)}</td>
                      <td className="font-sans text-slate-400">{t.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No closed trades yet</Empty>
          )}
        </Card>

        {/* AI ANALYSIS */}
        <Card
          title="AI analysis"
          actions={
            canTrade(user) && (
              <button className="btn-ghost !py-0.5 text-xs" onClick={runAi} disabled={aiBusy || !settings?.ai.enabled} title={settings?.ai.enabled ? '' : 'AI disabled in settings'}>
                {aiBusy ? 'Analyzing…' : `Analyze ${active}`}
              </button>
            )
          }
        >
          <ErrorText error={aiError} />
          <div className="mb-2 text-[11px] text-slate-500">AI output is advisory. It can veto trades but cannot place orders; the risk engine has final authority.</div>
          {analyses.data?.analyses.length ? (
            <div className="space-y-2">
              {analyses.data.analyses.map((a) => (
                <div key={a._id} className="rounded-lg border border-slate-800 p-2 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold">{a.symbol}</span>
                    {a.status === 'OK' ? <Badge color={signalColor(a.signal)}>{a.signal}</Badge> : <Badge color="red">{a.status}</Badge>}
                    {a.confidence !== undefined && <span className="text-slate-400">conf {fmtPct(a.confidence, 0)}</span>}
                    {a.marketRegime && <Badge color="blue">{a.marketRegime}</Badge>}
                    {a.riskLevel && <Badge color={a.riskLevel === 'HIGH' ? 'red' : a.riskLevel === 'MEDIUM' ? 'amber' : 'green'}>{a.riskLevel}</Badge>}
                    {a.newsSentiment && a.newsSentiment !== 'NONE' && <Badge color={a.newsSentiment === 'BULLISH' ? 'green' : a.newsSentiment === 'BEARISH' ? 'red' : 'slate'}>news {a.newsSentiment.toLowerCase()} ({a.newsCount})</Badge>}
                    <span className="ml-auto text-slate-500">{fmtTime(a.createdAt)}</span>
                  </div>
                  <div className="mt-1 text-slate-300">{a.reason ?? a.error}</div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>{settings?.ai.enabled ? 'No analyses yet' : 'AI analysis disabled'}</Empty>
          )}
        </Card>
      </div>

      <Card title="Latest strategy signals">
        {signals.data?.signals.length ? (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Strategy</th>
                  <th>Symbol</th>
                  <th>Signal</th>
                  <th>Conf</th>
                  <th>Regime</th>
                  <th>Decision</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {signals.data.signals.map((s) => (
                  <tr key={s._id}>
                    <td>{fmtTime(s.createdAt)}</td>
                    <td>{s.strategyKey}</td>
                    <td className="font-sans">{s.symbol} {s.timeframe}</td>
                    <td>
                      <Badge color={signalColor(s.action)}>{s.action}</Badge>
                    </td>
                    <td>{fmtPct(s.confidence, 0)}</td>
                    <td>{s.regime}</td>
                    <td>
                      <Badge color={s.decision === 'EXECUTE' ? 'green' : s.decision === 'REJECT' ? 'red' : 'slate'}>{s.decision}</Badge>
                    </td>
                    <td className="max-w-md truncate font-sans text-slate-400" title={(s.decisionReasons ?? []).join('\n')}>
                      {s.decision === 'REJECT' ? s.decisionReasons?.[0] : s.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No signals yet — enable a strategy at PAPER stage to start</Empty>
        )}
      </Card>
    </div>
  );
}

function Row({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono ${warn ? 'text-amber-400' : ''}`}>{value}</span>
    </div>
  );
}
