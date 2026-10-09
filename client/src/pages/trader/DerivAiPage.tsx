import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Bot, RefreshCw, Sparkles, Zap } from 'lucide-react';
import { Badge, Card, Empty, ErrorText, Modal, Stat } from '../../components/ui';
import { useToast } from '../../components/Toaster';
import { useApi } from '../../hooks/useApi';
import { api, ApiError } from '../../services/api';
import { fmtNum, fmtTime, pnlClass } from '../../utils/format';

// ------------------------------------------------------------------ server views (no secrets)

interface DerivConn {
  id: string;
  label?: string;
  accountId: string | null;
  environment: 'demo' | 'real';
  currency: string | null;
  balance: number | null;
  tradingEnabled: boolean;
  liveEnabled?: boolean;
  isDefault?: boolean;
}
interface StatusResponse {
  connections: DerivConn[];
  engineAccount: string | null;
  timeframes: string[];
}
interface Sym {
  symbol: string;
  name: string;
  marketName: string;
  open: boolean;
  suspended: boolean;
}
interface AiData {
  assessment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  regime: string;
  summary: string;
  confidence: number;
  confidenceExplanation: string;
  entryConditions: string[];
  invalidationConditions: string[];
  exitConditions: string[];
  avoidTrading: boolean;
  reasonsToAvoid: string[];
  dataQualityWarnings: string[];
  keyLevels: { support: number[]; resistance: number[] };
  riskReward: { available: boolean; ratio: number | null; basis: string };
}
interface Analysis {
  symbol: string;
  timeframe: string;
  price: number;
  dataTimestamp: number | null;
  regime: { regime: string; reason: string };
  signals: { strategy: string; action: string; confidence: number; reason: string }[];
  dataQuality: { warnings: string[]; stale: boolean };
  rules: { assessment: string; reasons: string[]; avoidTrading: boolean; reasonsToAvoid: string[]; note: string };
  ai: { status: string; data?: AiData; error?: string; analysisId?: string };
  disclaimer: string;
}
interface Plan {
  analysisId: string;
  environment: 'demo' | 'real';
  accountId: string;
  symbol: string;
  timeframe: string;
  assessment: string;
  confidence: number;
  summary: string;
  price: number;
  order: { side: 'buy' | 'sell'; product: string; multiplier?: number; stopLoss?: number; takeProfit?: number; duration?: number; durationUnit?: string; stake?: number; stopLossAmount?: number; takeProfitAmount?: number };
  risk: { approved: boolean; checks: { name: string; passed: boolean; detail: string }[]; maxLoss?: number; reasons: string[] } | null;
  blockers: string[];
  canExecute: boolean;
  notice: string;
}
type Pos = Record<string, unknown>;

const assessColor = (a?: string) => (a === 'BULLISH' ? 'green' : a === 'BEARISH' ? 'red' : 'slate') as 'green' | 'red' | 'slate';
const money = (v: unknown, ccy: string | null) => `${fmtNum(v)} ${ccy ?? ''}`;

/**
 * AI Trade: the AI reads real Deriv data and gives a direction; one click turns it into a trade.
 * The server re-checks the market, sets the stop from ATR, sizes the stake from your risk limits and
 * the risk engine can still refuse. Demo accounts trade immediately; real accounts need live trading
 * to be switched on explicitly.
 */
export function DerivAiPage() {
  const toast = useToast();
  const status = useApi<StatusResponse>('/deriv/status');
  const conns = status.data?.connections ?? [];
  const [connId, setConnId] = useState<string>('');
  useEffect(() => {
    if (!connId && conns.length) setConnId((conns.find((c) => c.environment === 'demo') ?? conns.find((c) => c.isDefault) ?? conns[0]).id);
  }, [conns, connId]);
  const conn = conns.find((c) => c.id === connId) ?? null;

  const symbols = useApi<{ symbols: Sym[] }>(conn ? `/deriv/accounts/${conn.id}/symbols` : null, [conn?.id]);
  const [symbol, setSymbol] = useState('R_100');
  const [timeframe, setTimeframe] = useState('5m');
  const [product, setProduct] = useState<'multiplier' | 'rise_fall'>('multiplier');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const positions = useApi<{ positions: Pos[] }>(conn ? `/brokers/connections/${conn.id}/positions` : null, [conn?.id]);
  const history = useApi<{ positions: Pos[] }>(conn ? `/brokers/connections/${conn.id}/positions?status=CLOSED` : null, [conn?.id]);

  const run = async <T,>(label: string, fn: () => Promise<T>) => {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
      return null;
    } finally {
      setBusy(null);
    }
  };
  const analyze = () => run('analyze', async () => {
    const r = await api<Analysis>(`/deriv/accounts/${conn!.id}/analyze`, { method: 'POST', body: { symbol, timeframe, ai: true } });
    setAnalysis(r);
    return r;
  });
  const preview = (analysisId: string) => run('preview', async () => {
    const r = await api<{ plan: Plan }>(`/deriv/accounts/${conn!.id}/ai-trade/preview`, { method: 'POST', body: { analysisId, product } });
    setPlan(r.plan);
    return r.plan;
  });
  /** The one-click path: fresh analysis → server plan → confirmation dialog. */
  const analyzeAndTrade = async () => {
    const a = await analyze();
    if (!a) return;
    if (a.ai.status !== 'OK' || !a.ai.analysisId) {
      setError(a.ai.error ?? `AI is ${a.ai.status.toLowerCase()} — cannot trade with AI`);
      return;
    }
    await preview(a.ai.analysisId);
  };
  const execute = () => run('execute', async () => {
    const r = await api<{ order: { status: string; rejectReason?: string }; duplicate: boolean }>(`/deriv/accounts/${conn!.id}/ai-trade`, { method: 'POST', body: { analysisId: plan!.analysisId, product } });
    const s = r.order.status;
    if (r.duplicate) toast('info', 'Already traded', 'This AI analysis already produced a trade. Run a new analysis for another.');
    else if (s === 'FILLED' || s === 'OPEN') toast('success', 'Trade opened', `Deriv confirmed the ${plan!.order.side === 'buy' ? 'UP' : 'DOWN'} contract on ${plan!.symbol}`);
    else if (s === 'UNKNOWN') toast('error', 'Waiting for Deriv', 'The result could not be verified yet. It will be checked before anything is retried.');
    else toast('error', 'Not traded', r.order.rejectReason ?? s);
    setPlan(null);
    void positions.reload();
    void history.reload();
    void status.reload();
  });

  if (status.loading && !status.data) return <div className="p-6 text-slate-400">Loading…</div>;
  if (!conns.length)
    return (
      <div className="mx-auto max-w-3xl p-4">
        <Card title="AI Trade">
          <Empty>
            Connect your Deriv account first on the <Link className="text-sky-400 underline" to="/brokers">Brokers</Link> page (a demo account is recommended to start).
          </Empty>
        </Card>
      </div>
    );

  const ai = analysis?.ai.data;
  return (
    <div className="mx-auto max-w-6xl space-y-4 overflow-y-auto p-3 sm:p-4">
      <Card
        title={
          <span className="flex items-center gap-2">
            <Sparkles size={18} className="text-violet-400" /> AI Trade
          </span>
        }
        actions={conn && <Badge color={conn.environment === 'demo' ? 'blue' : 'red'}>{conn.environment === 'demo' ? 'DEMO' : 'REAL MONEY'}</Badge>}
      >
        <div className="grid gap-3 sm:grid-cols-5">
          <div>
            <label className="label">Account</label>
            <select className="input" value={connId} onChange={(e) => (setConnId(e.target.value), setAnalysis(null))} aria-label="Deriv account">
              {conns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.environment === 'demo' ? 'Demo' : 'Real'} · {c.accountId} · {money(c.balance, c.currency)}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="label">Instrument</label>
            <select className="input" value={symbol} onChange={(e) => (setSymbol(e.target.value), setAnalysis(null))} aria-label="Instrument">
              {(symbols.data?.symbols ?? [{ symbol: 'R_100', name: 'Volatility 100 Index', marketName: '', open: true, suspended: false }]).map((s) => (
                <option key={s.symbol} value={s.symbol} disabled={!s.open || s.suspended}>
                  {s.name} {s.marketName ? `· ${s.marketName}` : ''} {!s.open ? '(closed)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Timeframe</label>
            <select className="input" value={timeframe} onChange={(e) => (setTimeframe(e.target.value), setAnalysis(null))} aria-label="Timeframe">
              {(status.data?.timeframes ?? ['1m', '5m', '15m', '1h']).map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Contract</label>
            <select className="input" value={product} onChange={(e) => setProduct(e.target.value as 'multiplier' | 'rise_fall')} aria-label="Contract type">
              <option value="multiplier">Multiplier (stop + target)</option>
              <option value="rise_fall">Rise / Fall</option>
            </select>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button className="btn-primary inline-flex items-center gap-2 !bg-violet-600 hover:!bg-violet-500" disabled={!conn || !!busy} onClick={() => void analyzeAndTrade()}>
            <Zap size={16} /> {busy === 'analyze' ? 'AI is reading the market…' : busy === 'preview' ? 'Building the trade…' : 'Trade with AI'}
          </button>
          <button className="btn-ghost inline-flex items-center gap-2" disabled={!conn || !!busy} onClick={() => void analyze()}>
            <RefreshCw size={14} /> Analyze only
          </button>
          {conn?.environment === 'real' && !conn.liveEnabled && <span className="text-xs text-amber-300">Real account: live trading is off, so trades will be refused. Use your demo account.</span>}
        </div>
        <p className="mt-2 text-xs text-slate-500">
          The AI chooses BUY (up) or SELL (down) from live Deriv data — or tells you to stay out. The server then re-checks the market, sets the stop from volatility (ATR), sizes the stake from your risk limits (0.5% per trade by default) and you confirm. No AI can guarantee profit: it is often wrong, and synthetic indices are random by design.
        </p>
        <ErrorText error={error} />
      </Card>

      {analysis && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title="AI decision" className="lg:col-span-2">
            {ai ? (
              <div className="space-y-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge color={assessColor(ai.assessment)}>{ai.assessment === 'BULLISH' ? 'BUY (UP)' : ai.assessment === 'BEARISH' ? 'SELL (DOWN)' : 'NO TRADE'}</Badge>
                  <Badge color="purple">Score {fmtNum(ai.confidence * 100, 0)}/100</Badge>
                  <Badge>{ai.regime}</Badge>
                  {ai.avoidTrading && <Badge color="amber">AI says: stay out</Badge>}
                </div>
                <p className="text-slate-200">{ai.summary}</p>
                <p className="text-xs text-slate-500">{ai.confidenceExplanation}</p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <List title="Entry when" items={ai.entryConditions} />
                  <List title="Wrong if" items={ai.invalidationConditions} />
                  <List title="Exit when" items={ai.exitConditions} />
                </div>
                {ai.reasonsToAvoid.length > 0 && <List title="Reasons to avoid" items={ai.reasonsToAvoid} warn />}
                {ai.dataQualityWarnings.length > 0 && <List title="Data warnings" items={ai.dataQualityWarnings} warn />}
                {ai.assessment !== 'NEUTRAL' && !ai.avoidTrading && analysis.ai.analysisId && (
                  <button className="btn-primary inline-flex items-center gap-2 !bg-violet-600" disabled={!!busy} onClick={() => void preview(analysis.ai.analysisId!)}>
                    <Bot size={16} /> Trade this ({ai.assessment === 'BULLISH' ? 'BUY' : 'SELL'})
                  </button>
                )}
              </div>
            ) : (
              <div className="text-sm text-amber-300">AI unavailable: {analysis.ai.error ?? analysis.ai.status}. The indicator reading is shown on the right.</div>
            )}
          </Card>
          <Card title="Market check">
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Price" value={fmtNum(analysis.price, 4)} sub={analysis.dataTimestamp ? fmtTime(analysis.dataTimestamp) : '—'} />
              <Stat label="Indicators" value={<Badge color={assessColor(analysis.rules.assessment)}>{analysis.rules.assessment}</Badge>} sub={analysis.regime.regime} />
            </div>
            <List title="Why" items={analysis.rules.reasons} />
            {analysis.dataQuality.warnings.length > 0 && <List title="Data" items={analysis.dataQuality.warnings} warn />}
            <div className="mt-2 space-y-1 text-xs">
              {analysis.signals.map((s) => (
                <div key={s.strategy} className="flex justify-between gap-2">
                  <span className="text-slate-400">{s.strategy}</span>
                  <Badge color={s.action === 'LONG' ? 'green' : s.action === 'SHORT' ? 'red' : 'slate'}>{s.action}</Badge>
                </div>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-slate-500">{analysis.disclaimer}</p>
          </Card>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Open contracts" actions={<button className="btn-ghost !px-2" onClick={() => void positions.reload()} aria-label="Refresh"><RefreshCw size={14} /></button>}>
          <PosTable rows={positions.data?.positions} ccy={conn?.currency ?? null} open />
        </Card>
        <Card title="Recent results">
          <PosTable rows={history.data?.positions?.slice(0, 15)} ccy={conn?.currency ?? null} />
        </Card>
      </div>

      <Modal open={!!plan} onClose={() => setPlan(null)} title={plan?.environment === 'real' ? 'Confirm REAL-money AI trade' : 'Confirm demo AI trade'}>
        {plan && (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-2">
              <Badge color={plan.environment === 'demo' ? 'blue' : 'red'}>{plan.environment === 'demo' ? 'DEMO' : 'REAL MONEY'}</Badge>
              <Badge color={plan.order.side === 'buy' ? 'green' : 'red'}>{plan.order.side === 'buy' ? 'BUY / UP' : 'SELL / DOWN'}</Badge>
              <Badge>{plan.symbol} · {plan.timeframe}</Badge>
              <Badge color="purple">AI score {fmtNum(plan.confidence * 100, 0)}/100</Badge>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Stake" value={money(plan.order.stake, conn?.currency ?? null)} />
              <Stat label="Max loss" value={money(plan.risk?.maxLoss, conn?.currency ?? null)} valueClass="text-red-300" />
              {plan.order.product === 'multiplier' ? (
                <>
                  <Stat label={`Stop (x${plan.order.multiplier})`} value={fmtNum(plan.order.stopLoss, 4)} sub={plan.order.stopLossAmount ? `−${money(plan.order.stopLossAmount, conn?.currency ?? null)}` : undefined} />
                  <Stat label="Target" value={fmtNum(plan.order.takeProfit, 4)} sub={plan.order.takeProfitAmount ? `+${money(plan.order.takeProfitAmount, conn?.currency ?? null)}` : undefined} />
                </>
              ) : (
                <Stat label="Duration" value={`${plan.order.duration} ${plan.order.durationUnit}`} />
              )}
            </div>
            {plan.blockers.length > 0 && <List title="Not trading because" items={plan.blockers} warn />}
            {plan.risk && !plan.risk.approved && <List title="Risk engine refused" items={plan.risk.checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`)} warn />}
            <p className="text-xs text-slate-400">{plan.notice}</p>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setPlan(null)}>
                Cancel
              </button>
              <button className={plan.environment === 'real' ? 'btn-danger' : 'btn-primary'} disabled={!plan.canExecute || !!busy} onClick={() => void execute()}>
                {busy === 'execute' ? 'Sending…' : plan.canExecute ? (plan.environment === 'real' ? 'Place REAL trade' : 'Place demo trade') : 'Cannot trade'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function List({ title, items, warn }: { title: string; items: string[]; warn?: boolean }) {
  if (!items.length) return null;
  return (
    <div className="mt-2">
      <div className={`mb-1 flex items-center gap-1 text-[11px] font-semibold tracking-wide uppercase ${warn ? 'text-amber-400' : 'text-slate-500'}`}>
        {warn && <AlertTriangle size={12} />} {title}
      </div>
      <ul className="list-disc space-y-0.5 pl-4 text-xs text-slate-300">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function PosTable({ rows, ccy, open }: { rows?: Pos[]; ccy: string | null; open?: boolean }) {
  if (!rows?.length) return <Empty>{open ? 'No open contracts' : 'No closed contracts yet'}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-left text-slate-500">
          <tr>
            <th className="py-1">Symbol</th>
            <th>Side</th>
            <th>Stake</th>
            <th>{open ? 'Unrealized' : 'P&L'}</th>
            <th>Source</th>
            <th>{open ? 'Opened' : 'Closed'}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const pnl = open ? r.unrealizedPnl : r.realizedPnl;
            return (
              <tr key={String(r._id)} className="border-t border-slate-800">
                <td className="py-1">{String(r.symbol)}</td>
                <td>{String(r.direction)}</td>
                <td>{money(r.amount, ccy)}</td>
                <td className={pnlClass(pnl)}>{fmtNum(pnl)}</td>
                <td>{r.strategyKey === 'ai-analyst' ? <Badge color="purple">AI</Badge> : String(r.strategyKey ?? 'manual')}</td>
                <td>{fmtTime(open ? r.openedAt : r.closedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
