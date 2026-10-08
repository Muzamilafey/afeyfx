import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Plug } from 'lucide-react';
import { Badge, Card } from '../../components/ui';
import { ProtectedActionButton } from '../../components/ProtectedActionButton';
import { useToast } from '../../components/Toaster';
import { useApi } from '../../hooks/useApi';
import { api } from '../../services/api';
import { fmtNum, fmtTime } from '../../utils/format';

type Route = 'internal' | 'deriv' | 'oanda';
type Cat = 'crypto' | 'forex' | 'metals';
interface BrokerView {
  id: 'deriv' | 'oanda';
  name: string;
  configured: boolean;
  supports: Cat[];
  settings: Record<string, unknown> & { multipliers?: Record<Cat, number> };
  lastTest: { ok: boolean; message: string; balance?: number; currency?: string; account?: string; demo?: boolean; at?: string } | null;
  openPositions: number;
}
interface View {
  liveTradingEnabledByEnv: boolean;
  simulatedMarketData: boolean;
  routes: Record<Cat, Route>;
  brokers: BrokerView[];
}

const CATS: { id: Cat; label: string }[] = [
  { id: 'crypto', label: 'Crypto' },
  { id: 'forex', label: 'Forex' },
  { id: 'metals', label: 'Metals' },
];

/**
 * Where traders' REAL-account orders are executed. "Internal" fills at the live market price on
 * the platform's own book; a broker route sends each order to that broker (live money).
 */
export function AdminBrokersPage() {
  const v = useApi<View>('/admin/brokers');
  const toast = useToast();
  const [deriv, setDeriv] = useState({ appId: '', token: '', crypto: 50, forex: 50, metals: 50 });
  useEffect(() => {
    const d = v.data?.brokers.find((b) => b.id === 'deriv');
    if (d) setDeriv((x) => ({ ...x, appId: String(d.settings.appId ?? ''), crypto: d.settings.multipliers?.crypto ?? 50, forex: d.settings.multipliers?.forex ?? 50, metals: d.settings.multipliers?.metals ?? 50 }));
  }, [v.data]);
  if (!v.data) return <div className="p-4 text-slate-500">Loading…</div>;
  const data = v.data;
  const test = async (id: string) => {
    try {
      const r = await api<{ ok: boolean; message: string }>(`/admin/brokers/${id}/test`, { method: 'POST' });
      toast(r.ok ? 'success' : 'error', r.ok ? 'Connected' : 'Connection failed', r.message);
      void v.reload();
    } catch (e) {
      toast('error', 'Test failed', (e as Error).message);
    }
  };
  const blocked = !data.liveTradingEnabledByEnv || data.simulatedMarketData;

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-bold text-slate-50">Brokers & order routing</h1>
      {blocked ? (
        <div className="flex gap-3 rounded-xl bg-amber-500/10 p-4 text-sm text-amber-200 ring-1 ring-amber-500/30">
          <AlertTriangle className="shrink-0 text-amber-400" size={20} />
          <div>
            External brokers are <b>locked</b>:{' '}
            {!data.liveTradingEnabledByEnv && (
              <>
                the server's <code>LIVE_TRADING_ENABLED</code> kill switch is off (set it in the server environment and restart — it cannot be changed here).{' '}
              </>
            )}
            {data.simulatedMarketData && <>simulated market data is active. </>}
            Real-account orders fill internally until then.
          </div>
        </div>
      ) : (
        <div className="flex gap-3 rounded-xl bg-emerald-500/10 p-4 text-sm text-emerald-200 ring-1 ring-emerald-500/30">
          <CheckCircle2 className="shrink-0 text-emerald-400" size={20} /> Kill switch is on: asset classes routed to a broker send real orders.
        </div>
      )}

      <Card title="Routing — where REAL-account orders execute">
        <div className="grid gap-3 md:grid-cols-3">
          {CATS.map((c) => {
            const cur = data.routes[c.id];
            return (
              <div key={c.id} className="rounded-xl bg-slate-950 p-4 ring-1 ring-slate-800">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-bold text-slate-100">{c.label}</span>
                  <Badge color={cur === 'internal' ? 'slate' : 'green'}>{cur === 'internal' ? 'Internal' : cur.toUpperCase()}</Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {(['internal', 'deriv', 'oanda'] as Route[])
                    .filter((r) => r === 'internal' || data.brokers.find((b) => b.id === r)?.supports.includes(c.id))
                    .map((r) =>
                      r === cur ? (
                        <span key={r} className="rounded-lg bg-sky-600 px-3 py-1 text-xs font-bold text-white">
                          {r === 'internal' ? 'Internal' : data.brokers.find((b) => b.id === r)!.name}
                        </span>
                      ) : (
                        <ProtectedActionButton
                          key={r}
                          label={r === 'internal' ? 'Internal' : data.brokers.find((b) => b.id === r)!.name}
                          className="btn-ghost !px-3 !py-1 text-xs"
                          title={`Route ${c.label} to ${r}`}
                          description={r === 'internal' ? `${c.label} orders will fill internally at the live market price.` : `New ${c.label} orders on traders' real accounts will be sent to ${r} as live orders. A connection test runs first. Positions already open stay where they are.`}
                          endpoint="/admin/brokers/routes"
                          method="PUT"
                          body={{ category: c.id, route: r }}
                          confirmText="Change route"
                          disabled={r !== 'internal' && blocked}
                          onDone={() => void v.reload()}
                        />
                      ),
                    )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        {data.brokers.map((b) => (
          <Card
            key={b.id}
            title={
              <span className="flex items-center gap-2">
                <Plug size={16} /> {b.name}
              </span>
            }
            actions={<Badge color={b.configured ? 'green' : 'slate'}>{b.configured ? 'Configured' : 'Not configured'}</Badge>}
          >
            <div className="mb-3 text-xs text-slate-400">
              Supports: {b.supports.join(', ')} · Open positions here: <b className="text-slate-200">{b.openPositions}</b>
            </div>
            {b.id === 'deriv' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="label">App ID</label>
                  <input className="input" value={deriv.appId} onChange={(e) => setDeriv({ ...deriv, appId: e.target.value.replace(/\D/g, '') })} placeholder="e.g. 12345" />
                </div>
                <div>
                  <label className="label">API token (trade scope only)</label>
                  <input className="input" type="password" autoComplete="off" value={deriv.token} onChange={(e) => setDeriv({ ...deriv, token: e.target.value })} placeholder={b.settings.token ? `Saved ${String(b.settings.token)} — blank keeps it` : 'Not set'} />
                </div>
                {(['crypto', 'forex', 'metals'] as Cat[]).map((c) => (
                  <div key={c}>
                    <label className="label">Multiplier — {c}</label>
                    <input className="input" type="number" min={1} value={deriv[c]} onChange={(e) => setDeriv({ ...deriv, [c]: Number(e.target.value) })} />
                  </div>
                ))}
                <div className="text-[11px] text-slate-500 sm:col-span-2">Orders use Deriv Multiplier contracts sized so exposure equals the trader's investment (stake = investment ÷ multiplier), with stop loss / take profit set at Deriv. Create the token with the "Trade" and "Read" scopes only — never "Payments".</div>
                <div className="flex justify-end sm:col-span-2">
                  <ProtectedActionButton label="Save Deriv settings" className="btn-primary" title="Save Deriv settings" description="Credentials are encrypted at rest." endpoint="/admin/brokers/deriv" method="PUT" body={{ appId: deriv.appId || undefined, token: deriv.token || undefined, multipliers: { crypto: deriv.crypto, forex: deriv.forex, metals: deriv.metals } }} confirmText="Save" onDone={() => (setDeriv({ ...deriv, token: '' }), void v.reload())} />
                </div>
              </div>
            ) : (
              <div className="text-sm text-slate-300">
                Uses the OANDA credentials from <a className="text-sky-400 underline" href="/admin/integrations">Integrations</a> ({String(b.settings.environment)} · account {String(b.settings.accountId || '—')}). Orders are fill-or-kill market orders with stop loss / take profit attached; the account must be in USD.
              </div>
            )}
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-800 pt-3">
              <div className="text-xs">
                {b.lastTest ? (
                  <span className={b.lastTest.ok ? 'text-emerald-400' : 'text-red-400'}>
                    {b.lastTest.message}
                    {b.lastTest.balance !== undefined && ` · balance ${fmtNum(b.lastTest.balance)} ${b.lastTest.currency ?? ''}`}
                    {b.lastTest.demo && ' · demo account'} <span className="text-slate-500">({fmtTime(b.lastTest.at)})</span>
                  </span>
                ) : (
                  <span className="text-slate-500">Not tested yet</span>
                )}
              </div>
              <button className="btn-ghost text-xs" disabled={!b.configured} onClick={() => void test(b.id)}>
                Test connection
              </button>
            </div>
          </Card>
        ))}
      </div>
      <div className="text-xs text-slate-500">
        Adding another broker means implementing one adapter (open, close, status, lookup, open positions, test) in <code>server/src/brokers</code>. Adapters have no deposit, withdrawal or transfer capability.
      </div>
    </div>
  );
}
