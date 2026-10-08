import { useState } from 'react';
import { Badge, Card, Empty, ErrorText, Tabs, statusColor } from '../components/ui';
import { ProtectedActionButton } from '../components/ProtectedActionButton';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../hooks/useAuth';
import { useSocketEvent } from '../hooks/useSocketEvent';
import { useTradingStatus } from '../hooks/useTradingStatus';
import { api } from '../services/api';
import { fmtTime } from '../utils/format';
import type { RiskStatus, SystemHealth, User } from '../types';

const TABS = ['Controls', 'Live mode', 'Risk', 'AI', 'Exchanges', 'Markets', 'Users', 'Logs'] as const;

export function AdminPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Controls');
  const { user } = useAuth();
  return (
    <div className="space-y-4">
      {!user?.twoFactorEnabled && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
          Enable 2FA (Account & 2FA) — every protected admin action requires a fresh 2FA code.
        </div>
      )}
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === 'Controls' && <Controls />}
      {tab === 'Live mode' && <LiveMode />}
      {tab === 'Risk' && <RiskAdmin />}
      {tab === 'AI' && <AiAdmin />}
      {tab === 'Exchanges' && <Exchanges />}
      {tab === 'Markets' && <Markets />}
      {tab === 'Users' && <Users />}
      {tab === 'Logs' && <Logs />}
    </div>
  );
}

function Controls() {
  const { settings, reload } = useTradingStatus();
  const health = useApi<SystemHealth>('/system/health');
  useSocketEvent('risk', () => void health.reload());
  const done = () => {
    void reload();
    void health.reload();
  };
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Emergency controls">
        <p className="mb-3 text-xs text-slate-400">Four separate actions. Each requires a fresh 2FA code. Emergency shutdown does not close positions — use “Close all positions” for that.</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <ProtectedActionButton label="Stop new trades" className="btn-warn" title="Stop new trades" description="Blocks all new entries. Stop-losses, take-profits and manual exits keep working." endpoint="/system/emergency/stop-new-trades" extraFields={[{ name: 'reason', label: 'Reason' }]} onDone={done} />
          <ProtectedActionButton label="Cancel open orders" className="btn-warn" title="Cancel all open orders" description={`Cancels every open order in ${settings?.mode ?? 'the current'} mode.`} endpoint="/system/emergency/cancel-orders" onDone={done} />
          <ProtectedActionButton label="Close all positions" className="btn-danger" title="Close ALL positions" description={`Market-closes every open position in ${settings?.mode ?? 'the current'} mode. Market orders may suffer slippage.`} endpoint="/system/emergency/close-positions" confirmText="Close everything" onDone={done} />
          <ProtectedActionButton label="EMERGENCY SHUTDOWN" className="btn-danger font-bold" title="Emergency shutdown" description="Stops new trades, halts the trading engine, cancels open orders and switches LIVE off (back to PAPER)." endpoint="/system/emergency/shutdown" extraFields={[{ name: 'reason', label: 'Reason' }]} confirmText="Shut down" onDone={done} />
        </div>
        <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-800 pt-3">
          <ProtectedActionButton label="Resume trading" className="btn-primary" title="Resume new trades" description="Re-allows new entries (circuit-breaker trips must be clear)." endpoint="/system/emergency/resume" onDone={done} disabled={settings?.emergencyShutdown} />
          {settings?.emergencyShutdown && <ProtectedActionButton label="Clear emergency" className="btn-ghost" title="Clear emergency shutdown" description="Clears the shutdown flag. Trading stays stopped until you resume it." endpoint="/system/emergency/clear-shutdown" onDone={done} />}
        </div>
      </Card>
      <Card title="System health" actions={<button className="btn-ghost text-xs" onClick={() => void health.reload()}>Refresh</button>}>
        {health.data ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              Overall <Badge color={statusColor(health.data.status)}>{health.data.status.toUpperCase()}</Badge>
              <span className="text-xs text-slate-500">uptime {Math.round(health.data.uptimeSec / 60)} min</span>
            </div>
            {Object.entries(health.data.components).map(([k, c]) => (
              <div key={k} className="flex items-start justify-between gap-2 border-b border-slate-800/60 pb-1">
                <span>{k}</span>
                <span className="flex flex-col items-end">
                  <Badge color={statusColor(c.status)}>{c.status}</Badge>
                  {c.detail != null && <span className="max-w-[320px] truncate text-[10px] text-slate-500" title={JSON.stringify(c.detail)}>{JSON.stringify(c.detail)}</span>}
                </span>
              </div>
            ))}
            <div className="text-xs text-slate-400">
              Mode {health.data.trading.mode} · env LIVE_TRADING_ENABLED={String(health.data.trading.liveTradingEnabledByEnv)} · trading {health.data.trading.tradingEnabled ? 'enabled' : 'STOPPED'}
            </div>
          </div>
        ) : (
          <ErrorText error={health.error} />
        )}
      </Card>
    </div>
  );
}

interface Preflight {
  passed: boolean;
  at: string;
  checks: { id: number; name: string; passed: boolean; detail: string }[];
}

function LiveMode() {
  const { settings, reload } = useTradingStatus();
  const live = useApi<{ mode: string; liveModeActive: boolean; liveTradingEnabledByEnv: boolean; lastPreflight: Preflight | null; confirmationPhrase: string }>('/system/live');
  const pf = live.data?.lastPreflight;
  const after = () => {
    void live.reload();
    void reload();
  };
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Live trading status">
        <div className="space-y-2 text-sm">
          <div>Current mode: <b className={settings?.mode === 'LIVE' ? 'text-red-400' : 'text-sky-300'}>{settings?.mode}</b></div>
          <div>
            Server switch LIVE_TRADING_ENABLED:{' '}
            {live.data?.liveTradingEnabledByEnv ? <Badge color="red">true</Badge> : <Badge color="green">false — live orders impossible</Badge>}
          </div>
          <p className="text-xs text-slate-400">
            LIVE requires: the server env switch, a passing preflight (credentials, trade permission, withdrawals disabled, market data, risk limits, balance, clock sync, exchange status, emergency stop clear, a human-approved LIVE strategy), your password, a fresh 2FA code and the typed confirmation phrase. It is never enabled automatically, and the server always restarts in PAPER.
          </p>
          <div className="flex flex-wrap gap-2 pt-2">
            <ProtectedActionButton label="Run preflight" className="btn-ghost" title="Run live preflight" description="Runs every live-trading safety check against the exchange. Read-only." endpoint="/system/live/preflight" onDone={after} />
            {settings?.mode === 'LIVE' ? (
              <button
                className="btn-primary"
                onClick={async () => {
                  await api('/system/live/disable', { method: 'POST' });
                  after();
                }}
              >
                Switch back to PAPER
              </button>
            ) : (
              <ProtectedActionButton
                label="Enable LIVE trading"
                className="btn-danger"
                title="Enable LIVE trading"
                description={
                  <div className="space-y-2">
                    <p className="font-semibold text-red-300">Real funds will be at risk. Losses can exceed expectations. No strategy guarantees profit.</p>
                    <p>Type exactly: <code className="rounded bg-slate-800 px-1">{live.data?.confirmationPhrase}</code></p>
                  </div>
                }
                endpoint="/system/live/enable"
                extraFields={[
                  { name: 'password', label: 'Password', type: 'password' },
                  { name: 'confirmation', label: 'Confirmation phrase' },
                ]}
                confirmText="Enable LIVE"
                disabled={!pf?.passed || !live.data?.liveTradingEnabledByEnv}
                onDone={after}
              />
            )}
          </div>
        </div>
      </Card>
      <Card title={`Preflight ${pf ? `· ${fmtTime(pf.at)}` : ''}`}>
        {pf ? (
          <div className="space-y-1">
            <div className="mb-2">{pf.passed ? <Badge color="green">ALL CHECKS PASSED</Badge> : <Badge color="red">FAILED — LIVE BLOCKED</Badge>}</div>
            {pf.checks.map((c) => (
              <div key={c.id} className="flex items-start gap-2 text-sm">
                <span className={c.passed ? 'text-emerald-400' : 'text-red-400'}>{c.passed ? '✔' : '✖'}</span>
                <span className="flex-1">
                  {c.name}
                  <div className="text-xs text-slate-500">{c.detail}</div>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <Empty>No preflight run yet</Empty>
        )}
      </Card>
    </div>
  );
}

const RISK_FIELDS: [string, string, number][] = [
  ['maxRiskPerTrade', 'Max risk per trade (fraction of equity)', 0.0001],
  ['maxDailyLoss', 'Max daily loss', 0.001],
  ['maxWeeklyLoss', 'Max weekly loss', 0.001],
  ['maxOpenPositions', 'Max open positions', 1],
  ['maxPortfolioExposure', 'Max portfolio exposure', 0.01],
  ['maxLeverage', 'Max leverage', 1],
  ['maxSpreadPct', 'Max spread', 0.0001],
  ['maxSlippagePct', 'Max slippage', 0.0001],
  ['maxCorrelatedPositions', 'Max correlated positions', 1],
  ['minRewardRisk', 'Min reward:risk', 0.1],
  ['minExpectedProfitPct', 'Min expected net profit', 0.0001],
];

function RiskAdmin() {
  const risk = useApi<RiskStatus>('/risk');
  const events = useApi<{ events: { _id: string; type: string; severity: string; message: string; createdAt: string }[] }>('/risk/events?limit=50');
  const [vals, setVals] = useState<Record<string, string>>({});
  const cfg = risk.data?.config ?? {};
  const body = Object.fromEntries(Object.entries(vals).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Risk limits">
        <div className="grid grid-cols-2 gap-2">
          {RISK_FIELDS.map(([k, label, step]) => (
            <div key={k}>
              <label className="label">{label}</label>
              <input className="input" type="number" step={step} placeholder={String(cfg[k] ?? '')} value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} />
            </div>
          ))}
        </div>
        <div className="mt-3">
          <ProtectedActionButton label="Save risk limits" className="btn-primary" title="Update risk limits" description={<pre className="text-xs">{JSON.stringify(body, null, 2)}</pre>} endpoint="/risk/config" method="PUT" body={body} onDone={() => (setVals({}), void risk.reload())} disabled={!Object.keys(body).length} />
        </div>
      </Card>
      <Card title="Circuit breaker">
        {risk.data?.circuitBreaker.trips.length ? (
          <div className="space-y-2">
            {risk.data.circuitBreaker.trips.map((t) => (
              <div key={t.code} className="flex items-center justify-between gap-2 rounded border border-red-900 bg-red-950/30 p-2 text-xs">
                <span>
                  <b>{t.code}</b> {t.autoReset ? <Badge color="amber">auto-reset</Badge> : <Badge color="red">manual reset</Badge>}
                  <div className="text-slate-300">{t.message}</div>
                  <div className="text-slate-500">{fmtTime(t.at)}</div>
                </span>
                <ProtectedActionButton label="Reset" className="btn-ghost text-xs" title={`Reset ${t.code}`} description="Only reset after the underlying problem has been investigated and resolved." endpoint="/risk/circuit-breaker/reset" body={{ code: t.code }} onDone={() => void risk.reload()} />
              </div>
            ))}
          </div>
        ) : (
          <Empty>Closed — no active trips</Empty>
        )}
        <div className="mt-4 card-title">Recent risk events</div>
        <div className="max-h-80 space-y-1 overflow-auto">
          {events.data?.events.map((e) => (
            <div key={e._id} className="text-xs">
              <Badge color={e.severity === 'CRITICAL' ? 'red' : e.severity === 'WARNING' ? 'amber' : 'slate'}>{e.type}</Badge> <span className="text-slate-400">{e.message}</span> <span className="text-slate-600">{fmtTime(e.createdAt)}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function AiAdmin() {
  const status = useApi<{ newsConfigured: boolean; enabled: boolean; configured: boolean; available: boolean; model: string; minConfidence: number; requireAgreement: boolean }>('/ai/status');
  const [model, setModel] = useState('');
  const [minConf, setMinConf] = useState('');
  const [error, setError] = useState<string | null>(null);
  const s = status.data;
  const save = async (body: Record<string, unknown>) => {
    try {
      await api('/settings/ai', { method: 'PUT', body });
      await status.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title="Claude AI analysis">
      <ErrorText error={error} />
      {s && (
        <div className="space-y-3 text-sm">
          <div>API key configured: {s.configured ? <Badge color="green">yes</Badge> : <Badge color="red">no (set ANTHROPIC_API_KEY on the server)</Badge>}</div>
          <div>News feeds: {s.newsConfigured ? <Badge color="green">configured</Badge> : <Badge color="slate">off (NEWS_ENABLED + NEWS_RSS_URLS)</Badge>}</div>
          <div className="flex items-center gap-2">
            Enabled: <Badge color={s.enabled ? 'green' : 'slate'}>{String(s.enabled)}</Badge>
            <button className="btn-ghost text-xs" onClick={() => void save({ enabled: !s.enabled })}>{s.enabled ? 'Disable' : 'Enable'}</button>
          </div>
          <div className="flex items-center gap-2">
            Require AI agreement: <Badge color={s.requireAgreement ? 'green' : 'amber'}>{String(s.requireAgreement)}</Badge>
            <button className="btn-ghost text-xs" onClick={() => void save({ requireAgreement: !s.requireAgreement })}>Toggle</button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div><label className="label">Model</label><input className="input" placeholder={s.model} value={model} onChange={(e) => setModel(e.target.value)} /></div>
            <div><label className="label">Min confidence (0.5–1)</label><input className="input" type="number" step="0.01" placeholder={String(s.minConfidence)} value={minConf} onChange={(e) => setMinConf(e.target.value)} /></div>
          </div>
          <button className="btn-primary" onClick={() => void save({ ...(model ? { model } : {}), ...(minConf ? { minConfidence: Number(minConf) } : {}) })}>Save</button>
          <p className="text-xs text-slate-500">Claude returns structured analysis only. It has no tools, cannot place orders, and can only veto a strategy signal. The risk engine has final authority.</p>
        </div>
      )}
    </Card>
  );
}

function Exchanges() {
  const ex = useApi<{ supported: string[]; exchanges: { name: string; status: string; lastHeartbeatAt?: string; lastError?: string }[] }>('/exchanges');
  const creds = useApi<{ credentials: { _id: string; exchange: string; label: string; keyHint: string; testnet: boolean; permissions?: { canTrade?: boolean; canWithdraw?: boolean; verifiedAt?: string } }[] }>('/exchanges/credentials');
  const [form, setForm] = useState({ exchange: 'binance', label: 'default', apiKey: '', apiSecret: '', passphrase: '', testnet: true });
  const [verify, setVerify] = useState<unknown>(null);
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Exchanges">
        {ex.data?.exchanges.map((e) => (
          <div key={e.name} className="mb-2 flex items-center justify-between text-sm">
            <span>{e.name} <Badge color={e.status === 'CONNECTED' ? 'green' : e.status === 'DEGRADED' ? 'amber' : 'red'}>{e.status}</Badge></span>
            <span className="text-xs text-slate-500">{e.lastError ?? fmtTime(e.lastHeartbeatAt)}</span>
          </div>
        ))}
        <div className="mt-3 flex flex-wrap gap-2">
          {ex.data?.supported.map((n) => (
            <button key={n} className="btn-ghost text-xs" onClick={async () => setVerify(await api(`/exchanges/${n}/verify`, { method: 'POST' }).catch((e) => ({ error: (e as Error).message })))}>
              Verify {n} key
            </button>
          ))}
        </div>
        {verify != null && <pre className="mt-2 max-h-60 overflow-auto rounded bg-slate-950 p-2 text-[11px]">{JSON.stringify(verify, null, 2)}</pre>}
        <div className="mt-4 card-title">Stored credentials (encrypted at rest — never shown)</div>
        {creds.data?.credentials.length ? (
          creds.data.credentials.map((c) => (
            <div key={c._id} className="mb-1 flex items-center justify-between text-xs">
              <span>
                {c.exchange}/{c.label} ••••{c.keyHint} {c.testnet && <Badge color="blue">testnet</Badge>} {c.permissions?.canWithdraw === false && <Badge color="green">no withdrawals</Badge>}
              </span>
              <ProtectedActionButton label="Delete" className="btn-ghost text-xs" title="Delete credential" description="Removes the encrypted key from the database." endpoint={`/exchanges/credentials/${c._id}`} method="DELETE" onDone={() => void creds.reload()} />
            </div>
          ))
        ) : (
          <Empty>None stored (env credentials may be in use)</Empty>
        )}
      </Card>
      <Card title="Add API key">
        <div className="mb-3 rounded border border-sky-900 bg-sky-950/40 p-2 text-xs text-sky-200">
          Create the key on the exchange with <b>trading enabled</b> and <b>withdrawals/transfers disabled</b>, restricted to your server IP. Keys with withdrawal permission are rejected. The secret is sent once over HTTPS, encrypted with AES-256-GCM on the server, and never returned to the browser.
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><label className="label">Exchange</label><select className="input" value={form.exchange} onChange={(e) => setForm({ ...form, exchange: e.target.value })}>{ex.data?.supported.map((s) => <option key={s}>{s}</option>)}</select></div>
          <div><label className="label">Label</label><input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></div>
          <div className="col-span-2"><label className="label">API key</label><input className="input" autoComplete="off" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} /></div>
          <div className="col-span-2"><label className="label">API secret</label><input className="input" type="password" autoComplete="off" value={form.apiSecret} onChange={(e) => setForm({ ...form, apiSecret: e.target.value })} /></div>
          <div className="col-span-2"><label className="label">Passphrase (if required)</label><input className="input" type="password" autoComplete="off" value={form.passphrase} onChange={(e) => setForm({ ...form, passphrase: e.target.value })} /></div>
          <label className="col-span-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={form.testnet} onChange={(e) => setForm({ ...form, testnet: e.target.checked })} /> Testnet / sandbox key</label>
        </div>
        <div className="mt-3">
          <ProtectedActionButton
            label="Verify & save key"
            className="btn-primary"
            title="Save exchange API key"
            description="The key's permissions will be checked with the exchange. Keys that can withdraw are refused."
            endpoint="/exchanges/credentials"
            body={{ ...form, passphrase: form.passphrase || undefined }}
            disabled={!form.apiKey || !form.apiSecret}
            onDone={() => {
              setForm({ ...form, apiKey: '', apiSecret: '', passphrase: '' });
              void creds.reload();
            }}
          />
        </div>
      </Card>
    </div>
  );
}

function Markets() {
  const m = useApi<{ markets: { _id: string; exchange: string; symbol: string; enabled: boolean; active: boolean; lastPrice?: number; minAmount?: number; takerFee?: number; timeframes: string[] }[] }>('/markets');
  return (
    <Card title="Markets">
      {m.data?.markets.length ? (
        <table className="table">
          <thead><tr><th>Exchange</th><th>Symbol</th><th>Last</th><th>Min amount</th><th>Taker fee</th><th>Timeframes</th><th>Enabled</th></tr></thead>
          <tbody>
            {m.data.markets.map((x) => (
              <tr key={x._id}>
                <td>{x.exchange}</td><td className="font-sans">{x.symbol}</td><td>{x.lastPrice}</td><td>{x.minAmount}</td><td>{x.takerFee}</td><td>{x.timeframes.join(',')}</td>
                <td>
                  <button className="btn-ghost !py-0.5 text-xs" onClick={async () => { await api(`/markets/${x._id}`, { method: 'PATCH', body: { enabled: !x.enabled } }); void m.reload(); }}>
                    {x.enabled ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>Markets are registered when market data starts (MARKET_SYMBOLS)</Empty>
      )}
    </Card>
  );
}

function Users() {
  const { user: me } = useAuth();
  const u = useApi<{ users: User[] }>('/users');
  const [form, setForm] = useState({ email: '', name: '', password: '', role: 'viewer' });
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card title="Users" className="xl:col-span-2">
        <table className="table">
          <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>2FA</th><th>Last login</th><th>Active</th></tr></thead>
          <tbody>
            {u.data?.users.map((x) => (
              <tr key={x._id}>
                <td className="font-sans">{x.email}</td>
                <td className="font-sans">{x.name}</td>
                <td>
                  <select className="rounded bg-slate-950 px-1 text-xs" value={x.role} disabled={x._id === me?._id} onChange={async (e) => { await api(`/users/${x._id}`, { method: 'PATCH', body: { role: e.target.value } }).catch((er) => setError((er as Error).message)); void u.reload(); }}>
                    {['viewer', 'trader', 'admin'].map((r) => <option key={r}>{r}</option>)}
                  </select>
                </td>
                <td>{x.twoFactorEnabled ? <Badge color="green">on</Badge> : <Badge color="amber">off</Badge>}</td>
                <td>{fmtTime(x.lastLoginAt)}</td>
                <td>
                  <button className="text-xs text-sky-400" disabled={x._id === me?._id} onClick={async () => { await api(`/users/${x._id}`, { method: 'PATCH', body: { active: !x.active } }).catch((er) => setError((er as Error).message)); void u.reload(); }}>
                    {x.active ? 'Deactivate' : 'Activate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Card title="Create user">
        <div className="space-y-2">
          <input className="input" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className="input" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input" type="password" placeholder="Initial password (12+)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{['viewer', 'trader', 'admin'].map((r) => <option key={r}>{r}</option>)}</select>
          <ErrorText error={error} />
          <button className="btn-primary w-full" onClick={async () => { try { await api('/users', { method: 'POST', body: form }); setForm({ email: '', name: '', password: '', role: 'viewer' }); void u.reload(); } catch (e) { setError((e as Error).message); } }}>Create</button>
        </div>
      </Card>
    </div>
  );
}

function Logs() {
  const [kind, setKind] = useState<'Audit' | 'Errors' | 'Notifications'>('Audit');
  const audit = useApi<{ logs: { _id: string; action: string; userEmail?: string; ip?: string; success: boolean; details?: unknown; createdAt: string }[] }>(kind === 'Audit' ? '/system/audit-logs?limit=200' : null, [kind]);
  const errors = useApi<{ events: { _id: string; type: string; level: string; component?: string; message: string; createdAt: string }[] }>(kind === 'Errors' ? '/system/events?limit=200' : null, [kind]);
  const notes = useApi<{ notifications: { _id: string; type: string; title: string; message: string; status: string; severity: string; createdAt: string }[] }>(kind === 'Notifications' ? '/notifications?limit=100' : null, [kind]);
  return (
    <Card actions={kind === 'Notifications' && <button className="btn-ghost text-xs" onClick={() => void api('/notifications/test', { method: 'POST' }).then(() => notes.reload())}>Send test notification</button>}>
      <Tabs tabs={['Audit', 'Errors', 'Notifications'] as const} value={kind} onChange={setKind} />
      <div className="max-h-[65vh] overflow-auto">
        {kind === 'Audit' && (
          <table className="table">
            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>OK</th><th>IP</th><th>Details</th></tr></thead>
            <tbody>
              {audit.data?.logs.map((l) => (
                <tr key={l._id}>
                  <td>{fmtTime(l.createdAt)}</td><td>{l.userEmail}</td><td>{l.action}</td><td>{l.success ? '✔' : <span className="text-red-400">✖</span>}</td><td>{l.ip}</td>
                  <td className="max-w-md truncate" title={JSON.stringify(l.details)}>{l.details ? JSON.stringify(l.details) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {kind === 'Errors' && (errors.data?.events.length ? errors.data.events.map((e) => <div key={e._id} className="text-xs"><Badge color={e.level === 'error' ? 'red' : 'amber'}>{e.type}</Badge> {e.component} — {e.message} <span className="text-slate-600">{fmtTime(e.createdAt)}</span></div>) : <Empty>No errors recorded</Empty>)}
        {kind === 'Notifications' && notes.data?.notifications.map((n) => (
          <div key={n._id} className="mb-1 text-xs">
            <Badge color={n.severity === 'CRITICAL' ? 'red' : n.severity === 'WARNING' ? 'amber' : 'slate'}>{n.type}</Badge> <b>{n.title}</b> — {n.message} <Badge color={n.status === 'SENT' ? 'green' : n.status === 'FAILED' ? 'red' : 'slate'}>{n.status}</Badge> <span className="text-slate-600">{fmtTime(n.createdAt)}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
