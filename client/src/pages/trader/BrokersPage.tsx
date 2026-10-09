import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Copy, ExternalLink, PlugZap, RefreshCw, ShieldAlert, Star } from 'lucide-react';
import { Badge, Card, Empty, ErrorText, Modal, Stat, Tabs } from '../../components/ui';
import { ConfirmCodeModal } from '../../components/ConfirmCodeModal';
import { useToast } from '../../components/Toaster';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../hooks/useAuth';
import { useFeatures } from '../../hooks/useFeatures';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { api, ApiError } from '../../services/api';
import { fmtNum, fmtPct, fmtTime, pnlClass } from '../../utils/format';

// ------------------------------------------------------------------ types (server views; no secrets)

interface Capability {
  status: 'implemented' | 'unsupported' | 'not_implemented';
  tested: 'mock' | 'none';
  note?: string;
}
interface Provider {
  provider: 'deriv' | 'mt5';
  name: string;
  kind: string;
  connectMethod: string;
  docs: string;
  readiness: string;
  eligibility: { kenya: string; note: string };
  capabilities: Record<string, Capability>;
  verified: { capability: string; verifiedOn: string; at: string }[];
  configured: { oauth?: boolean; token?: boolean; bridge?: boolean };
}
interface ProvidersResponse {
  providers: Provider[];
  evaluated: { name: string; status: string; reason: string }[];
  live: { envSwitch: boolean; userLiveAllowed: boolean; confirmPhrase: string };
  derivRedirectUri: string;
}
type RiskLimits = Record<string, number>;
interface Connection {
  id: string;
  provider: 'deriv' | 'mt5';
  providerName: string;
  label?: string;
  accountId: string | null;
  environment: 'demo' | 'real';
  currency: string | null;
  status: string;
  tradingEnabled: boolean;
  liveEnabled: boolean;
  isDefault: boolean;
  balance: number | null;
  equity: number | null;
  margin: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  leverage: number | null;
  lastSyncAt: string | null;
  lastHeartbeatAt: string | null;
  latencyMs: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  recoveredAt: string | null;
  breaker: { tripped: boolean; reason?: string; at?: string };
  riskLimits: RiskLimits;
  authMethod: string | null;
  terminal?: { terminalId: string; server?: string; company?: string; eaVersion?: string };
  features: string[];
  liveRequirements?: { envSwitch: boolean; adminAllows: boolean; confirmed: boolean };
  openPositions?: number;
  openOrders?: number;
}
interface Mt5Credentials {
  terminalId: string;
  terminalSecret: string;
  bridgeUrl: string;
}
interface Check {
  name: string;
  passed: boolean;
  message?: string;
}

const STATUS_COLOR: Record<string, 'green' | 'amber' | 'red' | 'slate'> = { CONNECTED: 'green', PENDING: 'amber', DISCONNECTED: 'amber', REAUTH_REQUIRED: 'amber', ERROR: 'red', REVOKED: 'slate' };
const ERROR_TEXT: Record<string, string> = {
  access_denied: 'You declined the authorization at Deriv.',
  missing_code: 'Deriv did not return an authorization code.',
  OAUTH_STATE_INVALID: 'The sign-in link expired or was opened in another browser. Please try again.',
  DERIV_SCOPE: 'Deriv granted a permission AfeyFX does not accept (payments). Nothing was connected.',
  failed: 'Deriv could not be connected. Please try again.',
};

const money = (v: number | null | undefined, ccy?: string | null) => (v === null || v === undefined ? '—' : `${fmtNum(v)} ${ccy ?? ''}`.trim());
const randomKey = () => `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// ------------------------------------------------------------------ generic confirmation

function ConfirmDialog({ open, title, children, danger, confirmText = 'Confirm', onClose, onConfirm }: { open: boolean; title: string; children: ReactNode; danger?: boolean; confirmText?: string; onClose(): void; onConfirm(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-3 text-sm text-slate-300">{children}</div>
      <ErrorText error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className={danger ? 'btn-danger' : 'btn-primary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : confirmText}
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ connect providers

function CopyField({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const toast = useToast();
  return (
    <div>
      <div className="label">{label}</div>
      <div className="flex gap-2">
        <input className={`input font-mono text-xs ${secret ? 'tracking-tight' : ''}`} readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} />
        <button className="btn-ghost !px-2" aria-label={`Copy ${label}`} onClick={() => navigator.clipboard?.writeText(value).then(() => toast('success', `${label} copied`))}>
          <Copy size={14} />
        </button>
      </div>
    </div>
  );
}

function Mt5SetupModal({ creds, onClose }: { creds: Mt5Credentials | null; onClose(): void }) {
  return (
    <Modal open={!!creds} onClose={onClose} title="Connect your MT5 terminal">
      {creds && (
        <div className="space-y-3 text-sm text-slate-300">
          <div className="flex gap-2 rounded-lg border border-amber-700/50 bg-amber-950/40 p-3 text-xs text-amber-200">
            <AlertTriangle size={16} className="shrink-0" />
            The terminal secret is shown only once. Store it in the EA's secret file now. AfeyFX never asks for your MT5 trading password.
          </div>
          <CopyField label="Bridge URL" value={creds.bridgeUrl} />
          <CopyField label="Terminal ID" value={creds.terminalId} />
          <CopyField label="Terminal secret" value={creds.terminalSecret} secret />
          <ol className="list-decimal space-y-1 pl-5 text-xs text-slate-400">
            <li>Copy <code>AfeyFXBridge.mq5</code> into <code>MQL5/Experts</code> and compile it in MetaEditor.</li>
            <li>
              In MT5: Tools → Options → Expert Advisors → allow WebRequest for <code>{new URL(creds.bridgeUrl).origin}</code>.
            </li>
            <li>
              Save the secret (one line) to <code>MQL5/Files/AfeyFXBridge/secret.txt</code>.
            </li>
            <li>Attach the EA to one chart and set BridgeUrl and TerminalId. Leave <code>AllowRealAccount</code> off for demo accounts.</li>
            <li>Turn on Algo Trading, then press “Test” on the connection here.</li>
          </ol>
          <p className="text-xs text-slate-500">See docs/BROKERS.md for the full protocol and troubleshooting.</p>
          <div className="flex justify-end">
            <button className="btn-primary" onClick={onClose}>
              I saved the secret
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ProviderCard({ p, onConnected }: { p: Provider; onConnected(creds?: Mt5Credentials): void }) {
  const toast = useToast();
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [env, setEnv] = useState<'demo' | 'real'>('demo');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const impl = Object.values(p.capabilities).filter((c) => c.status === 'implemented');
  const implemented = impl.length;
  const mockTested = impl.filter((c) => c.tested === 'mock').length;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <PlugZap size={16} className="text-sky-400" /> {p.name}
        </span>
      }
      actions={<Badge color={p.readiness === 'production-ready' ? 'green' : 'amber'}>{p.readiness.replace(/-/g, ' ')}</Badge>}
    >
      <p className="text-xs text-slate-400">{p.kind}</p>
      <p className="mt-1 text-xs text-slate-500">
        {implemented} capabilities implemented, {mockTested} covered by automated tests against mocked broker responses{p.verified.length ? `, ${p.verified.length} verified on a live session` : ', none verified on a live account yet'}.{' '}
        <a href={p.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-sky-400 hover:underline">
          API docs <ExternalLink size={11} />
        </a>
      </p>
      <p className="mt-2 rounded-md bg-slate-950/60 p-2 text-[11px] text-slate-400">
        <b className="text-slate-300">Eligibility ({p.eligibility.kenya}):</b> {p.eligibility.note}
      </p>
      <div className="mt-3 space-y-2">
        {p.provider === 'deriv' && (
          <>
            {p.configured.oauth && (
              <button
                className="btn-primary w-full"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    const r = await api<{ authorizeUrl: string }>('/brokers/deriv/connect', { method: 'POST', body: { method: 'oauth' } });
                    window.location.assign(r.authorizeUrl);
                  })
                }
              >
                Connect Deriv
              </button>
            )}
            {p.configured.token && (
              <>
                <button className="w-full text-xs text-slate-400 hover:text-slate-200" onClick={() => setShowToken((x) => !x)}>
                  {showToken ? 'Hide' : 'Use a personal access token instead'}
                </button>
                {showToken && (
                  <form
                    className="space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(async () => {
                        const r = await api<{ connections: Connection[] }>('/brokers/deriv/connect', { method: 'POST', body: { method: 'token', token } });
                        setToken('');
                        toast('success', 'Deriv connected', `${r.connections.length} account(s) added. Trading stays off until you enable it.`);
                        onConnected();
                      });
                    }}
                  >
                    <input className="input" type="password" autoComplete="off" placeholder="Token with the Trade scope only" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Deriv token" />
                    <p className="text-[11px] text-slate-500">Create a token with only the “Trade” and “Read” scopes. Never grant Payments. The token is sent once to the server and stored encrypted.</p>
                    <button className="btn-ghost w-full" disabled={busy || token.length < 8}>
                      Connect with token
                    </button>
                  </form>
                )}
              </>
            )}
          </>
        )}
        {p.provider === 'mt5' && p.configured.bridge && (
          <div className="flex gap-2">
            <select className="input !w-auto" value={env} onChange={(e) => setEnv(e.target.value as 'demo' | 'real')} aria-label="MT5 account type">
              <option value="demo">Demo account</option>
              <option value="real">Real account</option>
            </select>
            <button
              className="btn-primary flex-1"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await api<Mt5Credentials & { connection: Connection }>('/brokers/mt5/connect', { method: 'POST', body: { method: 'terminal', environment: env } });
                  onConnected({ terminalId: r.terminalId, terminalSecret: r.terminalSecret, bridgeUrl: r.bridgeUrl });
                })
              }
            >
              Connect MT5
            </button>
          </div>
        )}
        <ErrorText error={error} />
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ connection details

function OrderTicket({ c, onDone }: { c: Connection; onDone(): void }) {
  const toast = useToast();
  const [form, setForm] = useState({ brokerSymbol: '', side: 'buy', product: c.provider === 'mt5' ? 'cfd' : 'multiplier', multiplier: '50', stopLoss: '', takeProfit: '', duration: '5', durationUnit: 'm', volume: '', stake: '' });
  const [preview, setPreview] = useState<{ approved: boolean; checks: Check[]; order: Record<string, unknown>; maxLoss?: number } | null>(null);
  const [key, setKey] = useState(randomKey);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const instruments = useApi<{ instruments: { brokerSymbol: string; symbol: string; tradable: boolean }[] }>(`/brokers/connections/${c.id}/instruments`);
  const set = (k: keyof typeof form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setPreview(null);
  };
  const body = () => {
    const n = (v: string) => (v.trim() === '' ? undefined : Number(v));
    return {
      idempotencyKey: key,
      brokerSymbol: form.brokerSymbol,
      side: form.side,
      product: form.product,
      multiplier: form.product === 'multiplier' ? n(form.multiplier) : undefined,
      stopLoss: n(form.stopLoss),
      takeProfit: n(form.takeProfit),
      duration: form.product === 'rise_fall' ? n(form.duration) : undefined,
      durationUnit: form.product === 'rise_fall' ? form.durationUnit : undefined,
      volume: form.product === 'cfd' ? n(form.volume) : undefined,
      stake: form.product !== 'cfd' ? n(form.stake) : undefined,
    };
  };
  const doPreview = async () => {
    setError(null);
    try {
      setPreview(await api(`/brokers/connections/${c.id}/orders/preview`, { method: 'POST', body: body() }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const products = c.provider === 'mt5' ? ['cfd'] : ['multiplier', 'rise_fall'];
  return (
    <div className="space-y-3">
      {!c.tradingEnabled && <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-300">Trading is disabled on this account. You can preview, but orders will be rejected until you enable trading.</p>}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <div className="col-span-2">
          <label className="label">Instrument</label>
          <input className="input" list={`inst-${c.id}`} value={form.brokerSymbol} onChange={(e) => set('brokerSymbol', e.target.value.trim())} placeholder={c.provider === 'mt5' ? 'EURUSD' : 'frxEURUSD'} />
          <datalist id={`inst-${c.id}`}>
            {(instruments.data?.instruments ?? []).filter((i) => i.tradable).map((i) => (
              <option key={i.brokerSymbol} value={i.brokerSymbol}>
                {i.symbol}
              </option>
            ))}
          </datalist>
        </div>
        <div>
          <label className="label">Side</label>
          <select className="input" value={form.side} onChange={(e) => set('side', e.target.value)}>
            <option value="buy">{form.product === 'rise_fall' ? 'Rise' : 'Buy'}</option>
            <option value="sell">{form.product === 'rise_fall' ? 'Fall' : 'Sell'}</option>
          </select>
        </div>
        <div>
          <label className="label">Product</label>
          <select className="input" value={form.product} onChange={(e) => set('product', e.target.value)}>
            {products.map((p) => (
              <option key={p} value={p}>
                {p === 'cfd' ? 'CFD (market)' : p === 'multiplier' ? 'Multiplier' : 'Rise/Fall'}
              </option>
            ))}
          </select>
        </div>
        {form.product === 'multiplier' && (
          <div>
            <label className="label">Multiplier</label>
            <input className="input" inputMode="numeric" value={form.multiplier} onChange={(e) => set('multiplier', e.target.value)} />
          </div>
        )}
        {form.product === 'rise_fall' ? (
          <div>
            <label className="label">Duration</label>
            <div className="flex gap-1">
              <input className="input" inputMode="numeric" value={form.duration} onChange={(e) => set('duration', e.target.value)} />
              <select className="input !w-16" value={form.durationUnit} onChange={(e) => set('durationUnit', e.target.value)}>
                {['t', 's', 'm', 'h', 'd'].map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          <div>
            <label className="label">Stop loss (price) *</label>
            <input className="input" inputMode="decimal" value={form.stopLoss} onChange={(e) => set('stopLoss', e.target.value)} />
          </div>
        )}
        {form.product !== 'rise_fall' && (
          <div>
            <label className="label">Take profit (price)</label>
            <input className="input" inputMode="decimal" value={form.takeProfit} onChange={(e) => set('takeProfit', e.target.value)} />
          </div>
        )}
        <div>
          <label className="label">{form.product === 'cfd' ? 'Volume (lots)' : `Stake (${c.currency ?? ''})`}</label>
          <input className="input" inputMode="decimal" placeholder="auto (risk-sized)" value={form.product === 'cfd' ? form.volume : form.stake} onChange={(e) => set(form.product === 'cfd' ? 'volume' : 'stake', e.target.value)} />
        </div>
      </div>
      <div className="flex gap-2">
        <button className="btn-ghost" onClick={doPreview} disabled={!form.brokerSymbol}>
          Preview risk
        </button>
        <button className="btn-primary" disabled={!preview?.approved} onClick={() => setConfirm(true)}>
          Place order…
        </button>
      </div>
      <ErrorText error={error} />
      {preview && (
        <div className="rounded-lg border border-slate-800 p-3 text-xs">
          <div className="mb-2 flex items-center gap-2">
            <Badge color={preview.approved ? 'green' : 'red'}>{preview.approved ? 'Approved by risk engine' : 'Rejected by risk engine'}</Badge>
            {preview.maxLoss !== undefined && <span className="text-slate-400">Max loss ≈ {money(preview.maxLoss, c.currency)}</span>}
            {preview.order.volume !== undefined && <span className="text-slate-400">Volume {String(preview.order.volume)}</span>}
            {preview.order.stake !== undefined && <span className="text-slate-400">Stake {String(preview.order.stake)}</span>}
          </div>
          <ul className="grid gap-0.5 md:grid-cols-2">
            {preview.checks.map((ch) => (
              <li key={ch.name} className={ch.passed ? 'text-slate-400' : 'text-red-300'}>
                {ch.passed ? '✓' : '✕'} {ch.name}
                {ch.message ? ` — ${ch.message}` : ''}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title={`Send order to ${c.providerName}`}
        onClose={() => setConfirm(false)}
        confirmText={c.environment === 'real' ? 'Send REAL-money order' : 'Send demo order'}
        danger={c.environment === 'real'}
        onConfirm={async () => {
          const r = await api<{ order: { status: string; rejectReason?: string }; pending?: string; duplicate?: boolean }>(`/brokers/connections/${c.id}/orders`, { method: 'POST', body: body() }).catch((e) => {
            // 422 = rejected by the risk engine / broker: the body still describes the order.
            const b = e instanceof ApiError ? (e.body as { order?: { status: string; rejectReason?: string } } | undefined) : undefined;
            if (b?.order) return { order: b.order } as { order: { status: string; rejectReason?: string }; pending?: string; duplicate?: boolean };
            throw e;
          });
          setKey(randomKey());
          setPreview(null);
          const s = r.order.status;
          if (s === 'UNKNOWN') toast('error', 'Execution not verified', r.pending ?? 'The broker will be queried before anything is retried.');
          else if (s === 'REJECTED') toast('error', 'Order rejected', r.order.rejectReason);
          else toast('success', r.duplicate ? 'Already submitted' : `Order ${s.toLowerCase()}`, 'Confirmed by the broker.');
          onDone();
        }}
      >
        <p>
          {form.side.toUpperCase()} {form.brokerSymbol} ({form.product}) on <b>{c.environment === 'real' ? 'a REAL-money account' : 'a demo account'}</b>.
        </p>
        <p className="text-xs text-slate-400">The order is re-checked by the risk engine on the server. It is shown as filled only after the broker confirms it.</p>
      </ConfirmDialog>
    </div>
  );
}

function RiskLimitsForm({ c, onSaved }: { c: Connection; onSaved(): void }) {
  const toast = useToast();
  const fields: [string, string, 'pct' | 'num'][] = [
    ['maxRiskPerTrade', 'Risk per trade', 'pct'],
    ['maxDailyLoss', 'Daily loss limit', 'pct'],
    ['maxWeeklyLoss', 'Weekly loss limit', 'pct'],
    ['maxLeverage', 'Max leverage (x)', 'num'],
    ['maxOpenPositions', 'Max open positions', 'num'],
    ['maxExposurePct', 'Max exposure', 'pct'],
    ['maxSpreadPct', 'Max spread', 'pct'],
    ['maxSlippagePct', 'Max slippage', 'pct'],
    ['maxQuoteAgeMs', 'Max quote age (ms)', 'num'],
    ['maxConsecutiveFailures', 'Halt after failures', 'num'],
  ];
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(([k, , t]) => [k, String(t === 'pct' ? +((c.riskLimits?.[k] ?? 0) * 100).toFixed(4) : (c.riskLimits?.[k] ?? ''))])));
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      const body = Object.fromEntries(fields.map(([k, , t]) => [k, t === 'pct' ? Number(v[k]) / 100 : Number(v[k])]));
      await api(`/brokers/connections/${c.id}/limits`, { method: 'PUT', body });
      toast('success', 'Risk limits saved');
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {fields.map(([k, label, t]) => (
          <div key={k}>
            <label className="label">
              {label}
              {t === 'pct' ? ' %' : ''}
            </label>
            <input className="input" inputMode="decimal" value={v[k]} onChange={(e) => setV((x) => ({ ...x, [k]: e.target.value }))} />
          </div>
        ))}
      </div>
      <p className="text-xs text-slate-500">Limits are enforced on the server for every order on this account, manual or automated. Values outside safe bounds are refused.</p>
      <ErrorText error={error} />
      <button className="btn-primary" onClick={save}>
        Save limits
      </button>
    </div>
  );
}

function ListTable({ rows, cols, empty }: { rows: Record<string, unknown>[] | undefined; cols: [string, (r: Record<string, unknown>) => ReactNode][]; empty: string }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-slate-500">
            {cols.map(([h]) => (
              <th key={h} className="px-2 py-1 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={String(r._id ?? i)} className="border-t border-slate-800">
              {cols.map(([h, f]) => (
                <td key={h} className="px-2 py-1.5 whitespace-nowrap">
                  {f(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const DETAIL_TABS = ['Positions', 'Orders', 'History', 'Order ticket', 'Risk limits', 'Logs'] as const;

function ConnectionDetails({ c, reloadList, tick }: { c: Connection; reloadList(): void; tick: number }) {
  const toast = useToast();
  const [tab, setTab] = useState<(typeof DETAIL_TABS)[number]>('Positions');
  const positions = useApi<{ positions: Record<string, unknown>[] }>(tab === 'Positions' ? `/brokers/connections/${c.id}/positions` : null, [tick]);
  const orders = useApi<{ orders: Record<string, unknown>[] }>(tab === 'Orders' ? `/brokers/connections/${c.id}/orders` : null, [tick]);
  const trades = useApi<{ trades: Record<string, unknown>[] }>(tab === 'History' ? `/brokers/connections/${c.id}/trades` : null, [tick]);
  const logs = useApi<{ events: Record<string, unknown>[]; syncs: Record<string, unknown>[] }>(tab === 'Logs' ? `/brokers/connections/${c.id}/logs` : null, [tick]);
  const [closing, setClosing] = useState<Record<string, unknown> | null>(null);
  return (
    <div className="mt-4 border-t border-slate-800 pt-3">
      <Tabs tabs={DETAIL_TABS} value={tab} onChange={setTab} />
      {tab === 'Positions' && (
        <ListTable
          rows={positions.data?.positions}
          empty="No open positions on this account"
          cols={[
            ['Symbol', (r) => String(r.symbol)],
            ['Side', (r) => <Badge color={r.direction === 'LONG' ? 'green' : 'red'}>{String(r.direction)}</Badge>],
            ['Size', (r) => fmtNum(r.amount, 2)],
            ['Entry', (r) => fmtNum(r.entryPrice, 5)],
            ['Current', (r) => fmtNum(r.currentPrice, 5)],
            ['Open P&L', (r) => <span className={pnlClass(r.unrealizedPnl)}>{fmtNum(r.unrealizedPnl)}</span>],
            ['Source', (r) => String(r.strategyKey ?? 'manual')],
            ['Broker ref', (r) => <span className="font-mono">{String(r.brokerRef ?? '—')}</span>],
            [
              '',
              (r) => (
                <button className="text-red-400 hover:underline" onClick={() => setClosing(r)}>
                  Close
                </button>
              ),
            ],
          ]}
        />
      )}
      {tab === 'Orders' && (
        <ListTable
          rows={orders.data?.orders}
          empty="No orders yet"
          cols={[
            ['Time', (r) => fmtTime(r.createdAt)],
            ['Symbol', (r) => String(r.symbol)],
            ['Side', (r) => String(r.side)],
            ['Status', (r) => <Badge color={r.status === 'FILLED' ? 'green' : r.status === 'UNKNOWN' ? 'amber' : r.status === 'REJECTED' ? 'red' : 'slate'}>{String(r.status)}</Badge>],
            ['Size', (r) => fmtNum(r.filled || r.amount, 2)],
            ['Price', (r) => fmtNum(r.averagePrice, 5)],
            ['Reason', (r) => <span className="text-slate-400">{String(r.rejectReason ?? '')}</span>],
            [
              '',
              (r) =>
                r.status === 'OPEN' && r.brokerOrderId && c.features.includes('cancelOrder') ? (
                  <button className="text-amber-400 hover:underline" onClick={() => api(`/brokers/connections/${c.id}/orders/${String(r._id)}/cancel`, { method: 'POST' }).then((x) => toast((x as { confirmed: boolean }).confirmed ? 'success' : 'error', (x as { confirmed: boolean }).confirmed ? 'Order cancelled' : 'Cancel requested; awaiting the broker'), (e) => toast('error', 'Cancel failed', (e as Error).message)).finally(() => void orders.reload())}>
                    Cancel
                  </button>
                ) : null,
            ],
          ]}
        />
      )}
      {tab === 'History' && (
        <ListTable
          rows={trades.data?.trades}
          empty="No closed trades on this account"
          cols={[
            ['Closed', (r) => fmtTime(r.closedAt)],
            ['Symbol', (r) => String(r.symbol)],
            ['Side', (r) => String(r.direction)],
            ['Entry', (r) => fmtNum(r.entryPrice, 5)],
            ['Exit', (r) => fmtNum(r.exitPrice, 5)],
            ['Net P&L', (r) => <span className={pnlClass(r.netPnl)}>{fmtNum(r.netPnl)}</span>],
            ['Reason', (r) => String(r.exitReason ?? '')],
          ]}
        />
      )}
      {tab === 'Order ticket' && <OrderTicket c={c} onDone={reloadList} />}
      {tab === 'Risk limits' && <RiskLimitsForm c={c} onSaved={reloadList} />}
      {tab === 'Logs' && (
        <ListTable
          rows={logs.data?.events}
          empty="No events yet"
          cols={[
            ['Time', (r) => fmtTime(r.at)],
            ['Level', (r) => <Badge color={r.level === 'error' ? 'red' : r.level === 'warn' ? 'amber' : 'slate'}>{String(r.level ?? 'info')}</Badge>],
            ['Event', (r) => String(r.kind ?? r.type ?? '')],
            ['Message', (r) => <span className="whitespace-normal text-slate-300">{String(r.message ?? '')}</span>],
          ]}
        />
      )}
      <ConfirmDialog
        open={!!closing}
        title="Close position"
        danger
        confirmText="Request close"
        onClose={() => setClosing(null)}
        onConfirm={async () => {
          const r = await api<{ confirmed: boolean; message?: string }>(`/brokers/connections/${c.id}/positions/${String(closing!._id)}/close`, { method: 'POST' });
          toast(r.confirmed ? 'success' : 'error', r.confirmed ? 'Position closed (broker confirmed)' : 'Close requested', r.confirmed ? undefined : (r.message ?? 'Waiting for the broker to confirm.'));
          void positions.reload();
          reloadList();
        }}
      >
        <p>
          Close {String(closing?.symbol)} {String(closing?.direction)} at market?
        </p>
        <p className="text-xs text-slate-400">The position is shown as closed only after the broker confirms. Closing may fail outside market hours.</p>
      </ConfirmDialog>
    </div>
  );
}

// ------------------------------------------------------------------ connection card

type PendingAction = { title: string; body: ReactNode; danger?: boolean; confirmText?: string; run(): Promise<void> } | null;

function ConnectionCard({ c, providers, reload, tick, onMt5Creds }: { c: Connection; providers: ProvidersResponse | null; reload(): void; tick: number; onMt5Creds(c: Mt5Credentials): void }) {
  const toast = useToast();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const base = `/brokers/connections/${c.id}`;
  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      toast('error', `${name} failed`, (e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };
  const test = () =>
    act('Test', async () => {
      const r = await api<{ ok: boolean; message: string; latencyMs?: number }>(`${base}/test`, { method: 'POST' });
      toast(r.ok ? 'success' : 'error', r.ok ? 'Connection OK' : 'Connection test failed', r.message);
    });
  const sync = () =>
    act('Sync', async () => {
      const r = await api<{ reconcile?: { resolvedOrders: number; settled: number; adopted: number; unresolved: string[] } }>(`${base}/sync`, { method: 'POST' });
      const rc = r.reconcile;
      toast(rc?.unresolved?.length ? 'error' : 'success', 'Synced with broker', rc ? `${rc.settled} settled, ${rc.adopted} adopted, ${rc.resolvedOrders} orders resolved${rc.unresolved.length ? `, ${rc.unresolved.length} unresolved` : ''}` : undefined);
    });
  const reauth = () =>
    act('Reauthorize', async () => {
      const r = await api<{ authorizeUrl?: string } & Partial<Mt5Credentials>>(`${base}/reauthorize`, { method: 'POST' });
      if (r.authorizeUrl) window.location.assign(r.authorizeUrl);
      else if (r.terminalSecret) onMt5Creds({ terminalId: r.terminalId!, terminalSecret: r.terminalSecret, bridgeUrl: r.bridgeUrl! });
    });
  const isReal = c.environment === 'real';
  const liveBlocked = isReal && (!c.liveRequirements?.envSwitch || !c.liveRequirements?.adminAllows);
  return (
    <section className={`card ${isReal ? 'ring-1 ring-red-900/60' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-slate-50">{c.label || c.providerName}</h3>
            {c.isDefault && (
              <Badge color="blue">
                <Star size={10} className="mr-0.5" /> Default
              </Badge>
            )}
            <Badge color={isReal ? 'red' : 'amber'}>{isReal ? 'REAL MONEY' : 'DEMO'}</Badge>
            <Badge color={STATUS_COLOR[c.status] ?? 'slate'}>{c.status.replace('_', ' ')}</Badge>
            <Badge color={c.tradingEnabled ? 'green' : 'slate'}>{c.tradingEnabled ? 'Trading on' : 'Trading off'}</Badge>
            {isReal && <Badge color={c.liveEnabled ? 'red' : 'slate'}>{c.liveEnabled ? 'Live enabled' : 'Live locked'}</Badge>}
            {c.breaker.tripped && <Badge color="red">HALTED</Badge>}
          </div>
          <div className="mt-1 text-xs text-slate-400">
            {c.providerName} · Account <span className="font-mono">{c.accountId ?? 'not yet linked'}</span> · {c.currency ?? '—'}
            {c.terminal?.server ? ` · ${c.terminal.company ?? ''} ${c.terminal.server}` : ''}
            {c.terminal ? (
              <>
                {' '}
                · Terminal <span className="font-mono">{c.terminal.terminalId}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <button className="btn-ghost !py-1 text-xs" onClick={test} disabled={!!busy}>
            {busy === 'Test' ? 'Testing…' : 'Test'}
          </button>
          <button className="btn-ghost !py-1 text-xs" onClick={sync} disabled={!!busy}>
            <RefreshCw size={12} className={`mr-1 inline ${busy === 'Sync' ? 'animate-spin' : ''}`} />
            Sync
          </button>
          {!c.isDefault && (
            <button className="btn-ghost !py-1 text-xs" onClick={() => act('Set default', () => api(`${base}/default`, { method: 'POST' }).then(() => undefined))} disabled={!!busy}>
              Set default
            </button>
          )}
          <button className="btn-ghost !py-1 text-xs" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide details' : 'Details'}
          </button>
        </div>
      </div>

      {c.breaker.tripped && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-900 bg-red-950/40 p-2 text-xs text-red-200">
          <ShieldAlert size={14} /> New orders halted: {c.breaker.reason}
          <button className="ml-auto underline" onClick={() => setPending({ title: 'Resume this account', body: <p>Only resume after checking the broker platform: positions and orders there must match AfeyFX. Resuming is refused while any order's execution is still unverified.</p>, confirmText: 'Resume', run: () => api(`${base}/breaker/reset`, { method: 'POST' }).then(() => undefined) })}>
            Resume…
          </button>
        </div>
      )}
      {c.status === 'REAUTH_REQUIRED' && (
        <div className="mt-3 rounded-lg border border-amber-800 bg-amber-950/40 p-2 text-xs text-amber-200">
          Authorization expired. <button className="underline" onClick={reauth}>Reauthorize</button>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">
        <Stat label="Balance" value={money(c.balance, c.currency)} />
        <Stat label="Equity" value={money(c.equity, c.currency)} />
        <Stat label={c.features.includes('margin') ? 'Margin / free' : 'Margin'} value={c.features.includes('margin') ? `${fmtNum(c.margin)} / ${fmtNum(c.freeMargin)}` : 'n/a'} sub={c.marginLevel ? `Level ${fmtNum(c.marginLevel, 0)}%` : undefined} />
        <Stat label="Open" value={`${c.openPositions ?? 0} pos · ${c.openOrders ?? 0} ord`} />
        <Stat label="Last sync" value={<span className="text-xs">{c.lastSyncAt ? new Date(c.lastSyncAt).toLocaleTimeString() : '—'}</span>} sub={c.provider === 'mt5' ? `Heartbeat ${c.lastHeartbeatAt ? new Date(c.lastHeartbeatAt).toLocaleTimeString() : '—'}` : undefined} />
        <Stat label="Latency" value={c.latencyMs !== null ? `${c.latencyMs} ms` : '—'} />
      </div>
      {c.lastError && (
        <p className="mt-2 text-xs text-red-300">
          Last error ({fmtTime(c.lastErrorAt)}): {c.lastError}
          {c.recoveredAt && new Date(c.recoveredAt) > new Date(c.lastErrorAt ?? 0) ? <span className="text-emerald-400"> · recovered {fmtTime(c.recoveredAt)}</span> : null}
        </p>
      )}
      <p className="mt-2 text-[11px] text-slate-500">
        Features: {c.features.join(', ') || '—'} · Risk {fmtPct(c.riskLimits?.maxRiskPerTrade, 2)}/trade, {fmtPct(c.riskLimits?.maxDailyLoss, 1)}/day, {fmtPct(c.riskLimits?.maxWeeklyLoss, 1)}/week
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-800 pt-3">
        {c.tradingEnabled ? (
          <button className="btn-ghost !py-1 text-xs" onClick={() => act('Disable trading', () => api(`${base}/trading/disable`, { method: 'POST' }).then(() => undefined))}>
            Disable trading
          </button>
        ) : (
          <button
            className="btn-ghost !py-1 text-xs"
            disabled={c.status !== 'CONNECTED'}
            title={c.status !== 'CONNECTED' ? 'Test the connection first' : ''}
            onClick={() =>
              setPending({
                title: 'Enable trading on this account',
                body: (
                  <>
                    <p>
                      Strategies you assign and orders you place may then be sent to this <b>{isReal ? 'REAL-money' : 'demo'}</b> account, within its risk limits.
                    </p>
                    {isReal && <p className="text-xs text-amber-300">Real accounts additionally need live trading enabled below.</p>}
                  </>
                ),
                confirmText: 'Enable trading',
                run: () => api(`${base}/trading/enable`, { method: 'POST', body: { confirm: true } }).then(() => undefined),
              })
            }
          >
            Enable trading…
          </button>
        )}
        {isReal && !c.liveEnabled && (
          <button className="btn-ghost !py-1 text-xs text-red-300" disabled={liveBlocked} title={liveBlocked ? 'Live trading is switched off on the server' : ''} onClick={() => setLive(true)}>
            Enable live trading…
          </button>
        )}
        <button className="btn-ghost !py-1 text-xs" onClick={reauth}>
          {c.provider === 'mt5' ? 'Rotate terminal secret' : 'Reauthorize'}
        </button>
        <button
          className="btn-ghost !py-1 text-xs text-amber-300"
          onClick={() =>
            setPending({
              title: 'Cancel all pending orders',
              danger: true,
              body: <p>Request cancellation of every pending order on this account. Each order is reported as cancelled only when the broker confirms.</p>,
              confirmText: 'Cancel orders',
              run: async () => {
                const r = await api<{ results: { confirmed: boolean }[] }>(`${base}/emergency/cancel-orders`, { method: 'POST', body: { confirm: true } });
                toast('success', 'Cancel requested', `${r.results.filter((x) => x.confirmed).length}/${r.results.length} confirmed by the broker`);
              },
            })
          }
        >
          Cancel all orders
        </button>
        <button
          className="btn-danger !py-1 text-xs"
          onClick={() =>
            setPending({
              title: 'Emergency: close all positions',
              danger: true,
              body: (
                <>
                  <p>Trading on this account is disabled first, then every open position is sent a close request.</p>
                  <p className="text-xs text-amber-300">Closes can fail (market closed, liquidity, network, broker restrictions). Each result shows whether the broker confirmed it — check the broker platform for anything unconfirmed.</p>
                </>
              ),
              confirmText: 'Close everything',
              run: async () => {
                const r = await api<{ results: { brokerPositionId: string; confirmed: boolean; message: string }[] }>(`${base}/emergency/close-positions`, { method: 'POST', body: { confirm: true } });
                const ok = r.results.filter((x) => x.confirmed).length;
                toast(ok === r.results.length ? 'success' : 'error', `${ok}/${r.results.length} positions confirmed closed`, r.results.filter((x) => !x.confirmed).map((x) => `${x.brokerPositionId}: ${x.message}`).join('; ') || undefined);
              },
            })
          }
        >
          Close all positions
        </button>
        <button
          className="btn-ghost !py-1 text-xs text-red-400"
          onClick={() =>
            setPending({
              title: 'Disconnect this account',
              danger: true,
              body: (
                <>
                  <p>Trading stops, strategy assignments are disabled and stored credentials are deleted. Open positions stay open at the broker.</p>
                  {c.provider === 'deriv' ? <p className="text-xs text-slate-400">Also revoke AfeyFX under Deriv → Settings → Security → Connected apps / API tokens.</p> : <p className="text-xs text-slate-400">The terminal secret stops working immediately. Remove the EA from the chart.</p>}
                </>
              ),
              confirmText: 'Disconnect',
              run: () => api(`${base}/disconnect`, { method: 'POST', body: { confirm: true } }).then(() => undefined),
            })
          }
        >
          Disconnect
        </button>
      </div>

      {open && <ConnectionDetails c={c} reloadList={reload} tick={tick} />}

      <ConfirmDialog
        open={!!pending}
        title={pending?.title ?? ''}
        danger={pending?.danger}
        confirmText={pending?.confirmText}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          await pending!.run();
          reload();
        }}
      >
        {pending?.body}
      </ConfirmDialog>

      <ConfirmCodeModal
        open={live}
        onClose={() => setLive(false)}
        context="broker-live"
        title="Enable REAL-money trading"
        confirmText="Enable live trading"
        description={
          <div className="space-y-2">
            <p className="text-red-300">Orders on this account use real money. Losses can exceed what you expect; no strategy or AI result is guaranteed.</p>
            {!user?.twoFactorEnabled && <p className="text-amber-300">Two-factor authentication must be enabled on your AfeyFX account first (Account → Security).</p>}
            <label className="label">
              Type <b>{providers?.live.confirmPhrase ?? 'ENABLE LIVE TRADING'}</b>
            </label>
            <input className="input" value={phrase} onChange={(e) => setPhrase(e.target.value)} aria-label="Confirmation phrase" />
            <label className="label">Your AfeyFX password</label>
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" />
          </div>
        }
        onConfirm={async (code) => {
          await api(`${base}/live/enable`, { method: 'POST', body: { confirm: phrase, password, ...code } });
          setLive(false);
          setPhrase('');
          setPassword('');
          toast('success', 'Live trading enabled on this account');
          reload();
        }}
      />
    </section>
  );
}

// ------------------------------------------------------------------ strategy assignments

function Assignments({ connections }: { connections: Connection[] }) {
  const toast = useToast();
  const list = useApi<{ assignments: { _id: string; connection: string; strategyKey: string; symbolMap: Record<string, string>; product: string; multiplier?: number; enabled: boolean }[] }>('/brokers/assignments');
  const strategies = useApi<{ strategies?: { key: string; name: string; stage: string }[] } | { key: string; name: string; stage: string }[]>('/strategies');
  const strategyList = Array.isArray(strategies.data) ? strategies.data : (strategies.data?.strategies ?? []);
  const [form, setForm] = useState({ connectionId: '', strategyKey: '', platformSymbol: 'EUR/USD', brokerSymbol: '', product: 'cfd', multiplier: '50' });
  const [error, setError] = useState<string | null>(null);
  const conn = connections.find((c) => c.id === form.connectionId);
  const save = async (enabled: boolean, existing?: { connection: string; strategyKey: string; symbolMap: Record<string, string>; product: string; multiplier?: number }) => {
    setError(null);
    try {
      const body = existing
        ? { connectionId: existing.connection, strategyKey: existing.strategyKey, symbolMap: existing.symbolMap, product: existing.product, multiplier: existing.multiplier, enabled }
        : { connectionId: form.connectionId, strategyKey: form.strategyKey, symbolMap: { [form.platformSymbol]: form.brokerSymbol }, product: form.product, multiplier: form.product === 'multiplier' ? Number(form.multiplier) : undefined, enabled };
      await api('/brokers/assignments', { method: 'PUT', body });
      toast('success', enabled ? 'Strategy assigned' : 'Assignment paused');
      void list.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Card title="Strategy → account routing">
      <p className="mb-3 text-xs text-slate-500">Signals are sent only to accounts you assign here, never to every connected account. Each account applies its own risk limits; real accounts only receive strategies at the LIVE stage.</p>
      <ListTable
        rows={list.data?.assignments as unknown as Record<string, unknown>[]}
        empty="No strategies routed to broker accounts"
        cols={[
          ['Strategy', (r) => String(r.strategyKey)],
          ['Account', (r) => connections.find((c) => c.id === String(r.connection))?.label ?? 'disconnected'],
          ['Symbols', (r) => Object.entries((r.symbolMap ?? {}) as Record<string, string>).map(([a, b]) => `${a}→${b}`).join(', ')],
          ['Product', (r) => `${String(r.product)}${r.multiplier ? ` x${String(r.multiplier)}` : ''}`],
          ['State', (r) => <Badge color={r.enabled ? 'green' : 'slate'}>{r.enabled ? 'Active' : 'Paused'}</Badge>],
          [
            '',
            (r) => (
              <span className="flex gap-2">
                <button className="text-sky-400 hover:underline" onClick={() => save(!r.enabled, r as never)}>
                  {r.enabled ? 'Pause' : 'Resume'}
                </button>
                <button className="text-red-400 hover:underline" onClick={() => api(`/brokers/assignments/${String(r._id)}`, { method: 'DELETE' }).then(() => list.reload())}>
                  Remove
                </button>
              </span>
            ),
          ],
        ]}
      />
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-6">
        <select className="input" value={form.connectionId} onChange={(e) => setForm((f) => ({ ...f, connectionId: e.target.value, product: connections.find((c) => c.id === e.target.value)?.provider === 'deriv' ? 'multiplier' : 'cfd' }))} aria-label="Account">
          <option value="">Account…</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} ({c.environment})
            </option>
          ))}
        </select>
        <select className="input" value={form.strategyKey} onChange={(e) => setForm((f) => ({ ...f, strategyKey: e.target.value }))} aria-label="Strategy">
          <option value="">Strategy…</option>
          {strategyList.map((s) => (
            <option key={s.key} value={s.key}>
              {s.name} ({s.stage})
            </option>
          ))}
        </select>
        <input className="input" value={form.platformSymbol} onChange={(e) => setForm((f) => ({ ...f, platformSymbol: e.target.value }))} placeholder="EUR/USD" aria-label="Platform symbol" />
        <input className="input" value={form.brokerSymbol} onChange={(e) => setForm((f) => ({ ...f, brokerSymbol: e.target.value.trim() }))} placeholder={conn?.provider === 'deriv' ? 'frxEURUSD' : 'EURUSD'} aria-label="Broker symbol" />
        <select className="input" value={form.product} onChange={(e) => setForm((f) => ({ ...f, product: e.target.value }))} aria-label="Product">
          {(conn?.provider === 'deriv' ? ['multiplier', 'rise_fall'] : ['cfd']).map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <button className="btn-primary" disabled={!form.connectionId || !form.strategyKey || !form.brokerSymbol} onClick={() => save(true)}>
          Assign
        </button>
      </div>
      <ErrorText error={error} />
    </Card>
  );
}

// ------------------------------------------------------------------ page

export function BrokersPage() {
  const toast = useToast();
  const { features } = useFeatures();
  const [params, setParams] = useSearchParams();
  const providers = useApi<ProvidersResponse>('/brokers');
  const list = useApi<{ connections: Connection[] }>('/brokers/connections');
  const [creds, setCreds] = useState<Mt5Credentials | null>(null);
  const [tick, setTick] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Deriv OAuth return: ?connected=deriv&accounts=N or #error=CODE
  useEffect(() => {
    if (params.get('connected') === 'deriv') {
      toast('success', 'Deriv connected', `${params.get('accounts') ?? 'Your'} account(s) linked. Trading stays off until you enable it on each account.`);
      setParams({}, { replace: true });
    }
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const err = hash.get('error');
    if (err) {
      toast('error', 'Deriv was not connected', ERROR_TEXT[err] ?? `Error: ${err}`);
      window.history.replaceState(null, '', window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadList = list.reload;
  const refresh = useCallback(() => {
    void reloadList();
    setTick((t) => t + 1);
  }, [reloadList]);

  // Broker events are routed to this user's room only. Quotes are frequent: ignore them here.
  useSocketEvent<{ kind?: string; connection?: string }>('broker', (e) => {
    if (!e || e.kind === 'quote') return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(refresh, 400);
  });
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const connections = useMemo(() => list.data?.connections ?? [], [list.data]);
  const visibleProviders = (providers.data?.providers ?? []).filter((p) => (p.provider === 'deriv' ? features.derivConnect : features.mt5Connect));
  const live = providers.data?.live;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">Broker connections</h1>
          <p className="text-sm text-slate-400">Connect your own broker accounts. Demo accounts first; AfeyFX never has withdrawal access.</p>
        </div>
        <button className="btn-ghost" onClick={refresh}>
          <RefreshCw size={14} className="mr-1 inline" /> Refresh
        </button>
      </div>

      {live && (
        <div className={`rounded-lg border p-3 text-xs ${live.envSwitch && live.userLiveAllowed ? 'border-red-900 bg-red-950/30 text-red-200' : 'border-slate-800 bg-slate-900 text-slate-400'}`}>
          {live.envSwitch && live.userLiveAllowed ? 'Real-money trading can be enabled per account (password, 2FA and a typed confirmation are required).' : 'Real-money trading is switched off on this server. Real accounts can be connected and monitored, but no orders will be sent to them.'}
        </div>
      )}

      <ErrorText error={providers.error ?? list.error} />

      {connections.length > 0 ? (
        <div className="space-y-3">
          {connections.map((c) => (
            <ConnectionCard key={c.id} c={c} providers={providers.data} reload={refresh} tick={tick} onMt5Creds={setCreds} />
          ))}
        </div>
      ) : (
        !list.loading && (
          <Card>
            <Empty>No broker accounts connected yet.</Empty>
          </Card>
        )
      )}

      {visibleProviders.length > 0 && (
        <>
          <h2 className="pt-2 text-sm font-semibold tracking-wide text-slate-400 uppercase">Add a connection</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {visibleProviders.map((p) => (
              <ProviderCard
                key={p.provider}
                p={p}
                onConnected={(c) => {
                  if (c) setCreds(c);
                  refresh();
                }}
              />
            ))}
          </div>
        </>
      )}

      {connections.length > 0 && <Assignments connections={connections} />}

      {!!providers.data?.evaluated.length && (
        <Card title="Other providers">
          <ul className="space-y-2 text-xs text-slate-400">
            {providers.data.evaluated.map((e) => (
              <li key={e.name}>
                <b className="text-slate-200">{e.name}</b> <Badge>{e.status}</Badge> — {e.reason}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Mt5SetupModal creds={creds} onClose={() => setCreds(null)} />
    </div>
  );
}
