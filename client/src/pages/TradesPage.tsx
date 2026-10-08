import { useState } from 'react';
import { Badge, Card, Empty, Modal, Tabs, signalColor, statusColor } from '../components/ui';
import { useApi } from '../hooks/useApi';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { useTradingStatus } from '../hooks/useTradingStatus';
import { api } from '../services/api';
import { fmtNum, fmtPct, fmtPrice, fmtSigned, fmtTime, pnlClass } from '../utils/format';
import type { Mode, Order, Signal, Trade } from '../types';

const TABS = ['Trades', 'Orders', 'Signals'] as const;

export function TradesPage() {
  const { settings } = useTradingStatus();
  const [mode, setMode] = useState<Mode | null>(null);
  const m = mode ?? settings?.mode ?? 'PAPER';
  const [tab, setTab] = useState<(typeof TABS)[number]>('Trades');
  const [skip, setSkip] = useState(0);
  const [trace, setTrace] = useState<unknown>(null);

  const trades = useApi<{ trades: Trade[]; total: number }>(`/trades?mode=${m}&limit=50&skip=${skip}`, [m, skip]);
  const orders = useApi<{ orders: Order[] }>(`/orders?mode=${m}&limit=100`, [m]);
  const signals = useApi<{ signals: Signal[] }>(`/signals?mode=${m}&limit=100`, [m]);
  useSocketEvent('trade', () => void trades.reload());
  useSocketEvent('order', () => void orders.reload());
  useSocketEvent('signal', () => void signals.reload());

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-400">Mode:</span>
        {(['PAPER', 'LIVE'] as const).map((x) => (
          <button key={x} className={`rounded px-3 py-1 text-xs font-semibold ${m === x ? (x === 'LIVE' ? 'bg-red-600' : 'bg-sky-700') : 'bg-slate-800 text-slate-400'}`} onClick={() => setMode(x)}>
            {x}
          </button>
        ))}
        <span className="text-xs text-slate-500">Paper and live records are stored and reported separately.</span>
      </div>
      <Card>
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
        {tab === 'Trades' &&
          (trades.data?.trades.length ? (
            <>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Opened</th><th>Closed</th><th>Symbol</th><th>Strategy</th><th>Dir</th><th>Size</th><th>Entry</th><th>Exit</th><th>Gross</th><th>Fees</th><th>Slippage</th><th>Net</th><th>Return</th><th>Exit reason</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {trades.data.trades.map((t) => (
                      <tr key={t._id}>
                        <td>{fmtTime(t.openedAt)}</td>
                        <td>{fmtTime(t.closedAt)}</td>
                        <td className="font-sans">{t.symbol}</td>
                        <td>{t.strategyKey ?? '—'}</td>
                        <td><Badge color={signalColor(t.direction)}>{t.direction}</Badge></td>
                        <td>{fmtNum(t.amount, 6)}</td>
                        <td>{fmtPrice(t.entryPrice)}</td>
                        <td>{fmtPrice(t.exitPrice)}</td>
                        <td className={pnlClass(t.grossPnl)}>{fmtSigned(t.grossPnl)}</td>
                        <td>{fmtNum(t.fees)}</td>
                        <td>{fmtNum(t.slippage)}</td>
                        <td className={pnlClass(t.netPnl)}>{fmtSigned(t.netPnl)}</td>
                        <td className={pnlClass(t.returnPct)}>{fmtPct(t.returnPct)}</td>
                        <td className="font-sans text-slate-400">{t.exitReason}</td>
                        <td><button className="text-xs text-sky-400 hover:underline" onClick={async () => setTrace(await api(`/trades/${t._id}/trace`))}>trace</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                <span>{trades.data.total} trades (losing trades included)</span>
                <div className="flex gap-2">
                  <button className="btn-ghost" disabled={skip === 0} onClick={() => setSkip(Math.max(0, skip - 50))}>Prev</button>
                  <button className="btn-ghost" disabled={skip + 50 >= trades.data.total} onClick={() => setSkip(skip + 50)}>Next</button>
                </div>
              </div>
            </>
          ) : (
            <Empty>No trades</Empty>
          ))}
        {tab === 'Orders' &&
          (orders.data?.orders.length ? (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr><th>Created</th><th>Symbol</th><th>Side</th><th>Type</th><th>Purpose</th><th>Amount</th><th>Filled</th><th>Avg price</th><th>Fee</th><th>Status</th><th>Idempotency key</th><th>Note</th></tr>
                </thead>
                <tbody>
                  {orders.data.orders.map((o) => (
                    <tr key={o._id}>
                      <td>{fmtTime(o.createdAt)}</td>
                      <td className="font-sans">{o.symbol}</td>
                      <td className={o.side === 'buy' ? 'text-emerald-400' : 'text-red-400'}>{o.side}</td>
                      <td>{o.type}</td>
                      <td>{o.purpose}</td>
                      <td>{fmtNum(o.amount, 6)}</td>
                      <td>{fmtNum(o.filled, 6)}</td>
                      <td>{fmtPrice(o.averagePrice)}</td>
                      <td>{fmtNum(o.fee, 4)}</td>
                      <td><Badge color={statusColor(o.status)}>{o.status}</Badge></td>
                      <td className="max-w-[160px] truncate" title={o.idempotencyKey}>{o.idempotencyKey}</td>
                      <td className="max-w-xs truncate font-sans text-slate-400" title={o.rejectReason}>{o.rejectReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No orders</Empty>
          ))}
        {tab === 'Signals' &&
          (signals.data?.signals.length ? (
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr><th>Time</th><th>Strategy</th><th>Symbol</th><th>Action</th><th>Conf</th><th>Price</th><th>Regime</th><th>Decision</th><th>Reasons</th></tr>
                </thead>
                <tbody>
                  {signals.data.signals.map((s) => (
                    <tr key={s._id}>
                      <td>{fmtTime(s.createdAt)}</td>
                      <td>{s.strategyKey}</td>
                      <td className="font-sans">{s.symbol} {s.timeframe}</td>
                      <td><Badge color={signalColor(s.action)}>{s.action}</Badge></td>
                      <td>{fmtPct(s.confidence, 0)}</td>
                      <td>{fmtPrice(s.price)}</td>
                      <td>{s.regime}</td>
                      <td><Badge color={s.decision === 'EXECUTE' ? 'green' : s.decision === 'REJECT' ? 'red' : 'slate'}>{s.decision}</Badge></td>
                      <td className="max-w-md font-sans text-slate-400">{(s.decisionReasons?.length ? s.decisionReasons : [s.reason]).join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty>No signals</Empty>
          ))}
      </Card>
      <Modal open={!!trace} onClose={() => setTrace(null)} title="Trade audit trail">
        <div className="mb-2 text-xs text-slate-400">User → strategy → signal → AI analysis → risk evaluation → orders → exchange responses → fills → P&L</div>
        <pre className="max-h-[60vh] overflow-auto rounded bg-slate-950 p-2 text-[11px]">{JSON.stringify(trace, null, 2)}</pre>
      </Modal>
    </div>
  );
}
