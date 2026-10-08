import { useEffect, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import { Badge, Card, Empty, Stat, Tabs } from '../../components/ui';
import { ProtectedActionButton } from '../../components/ProtectedActionButton';
import { STATUS_STYLE } from '../../components/AccountTabs';
import { useToast } from '../../components/Toaster';
import { useApi } from '../../hooks/useApi';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { useFeatures } from '../../hooks/useFeatures';
import { api } from '../../services/api';
import { fmtNum, fmtTime } from '../../utils/format';
import type { Payment } from '../../types';

interface AdminConfig {
  depositsEnabled: boolean;
  payoutsEnabled: boolean;
  realTradingEnabled: boolean;
  environment: 'sandbox' | 'production' | 'simulated';
  shortcode: string;
  transactionType: string;
  partyB: string;
  accountReference: string;
  b2cShortcode: string;
  initiatorName: string;
  b2cCommandId: string;
  callbackIps: string[];
  depositRate: number;
  payoutRate: number;
  minDepositUsd: number;
  maxDepositUsd: number;
  minPayoutUsd: number;
  maxPayoutUsd: number;
  dailyPayoutLimitUsd: number;
  payoutFeePct: number;
  payoutFeeFixedUsd: number;
  autoApproveBelowUsd: number;
  payoutsToDepositPhonesOnly: boolean;
  secrets: { consumerKey: string; consumerSecret: boolean; passkey: boolean; securityCredential: boolean };
  status: { depositsConfigured: boolean; payoutsConfigured: boolean; callbackBaseIsHttps: boolean; simulatedAllowed: boolean; simulatedMarketData: boolean };
  callbackUrls: { stk: string; b2cResult: string; b2cTimeout: string };
}
interface Stats {
  pendingPayouts: number;
  needsReview: number;
  deposits24h: { count: number; amount: number };
  payouts24h: { count: number; amount: number };
  failed24h: number;
}

const TABS = ['Transactions', 'M-Pesa settings'] as const;

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange(v: boolean): void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg bg-slate-950 px-3 py-2.5 ring-1 ring-slate-800">
      <span className="text-sm text-slate-200">{label}</span>
      <input type="checkbox" className="h-5 w-5 accent-emerald-500" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Settings({ onSaved }: { onSaved(): void }) {
  const cfg = useApi<AdminConfig>('/admin/payments/config');
  const toast = useToast();
  const { reload: reloadFeatures } = useFeatures();
  const [f, setF] = useState<Partial<AdminConfig> & Record<string, unknown>>({});
  const [secrets, setSecrets] = useState({ consumerKey: '', consumerSecret: '', passkey: '', securityCredential: '' });
  useEffect(() => {
    if (cfg.data) setF({ ...cfg.data });
  }, [cfg.data]);
  if (!cfg.data) return <Card>Loading…</Card>;
  const c = cfg.data;
  const set = (k: string, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const num = (k: keyof AdminConfig, step = 1) => <input className="input" type="number" step={step} value={String(f[k] ?? '')} onChange={(e) => set(k, Number(e.target.value))} />;
  const text = (k: keyof AdminConfig, ph = '') => <input className="input" value={String(f[k] ?? '')} placeholder={ph} onChange={(e) => set(k, e.target.value)} />;
  const secret = (k: keyof typeof secrets, isSet: boolean | string) => <input className="input" type="password" autoComplete="off" placeholder={isSet ? `Saved ${typeof isSet === 'string' ? isSet : '••••••••'} — leave blank to keep` : 'Not set'} value={secrets[k]} onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })} />;
  const body = {
    depositsEnabled: f.depositsEnabled,
    payoutsEnabled: f.payoutsEnabled,
    realTradingEnabled: f.realTradingEnabled,
    environment: f.environment,
    shortcode: f.shortcode,
    transactionType: f.transactionType,
    partyB: f.partyB,
    accountReference: f.accountReference,
    b2cShortcode: f.b2cShortcode,
    initiatorName: f.initiatorName,
    b2cCommandId: f.b2cCommandId,
    callbackIps: typeof f.callbackIps === 'string' ? (f.callbackIps as string).split(',').map((s) => s.trim()).filter(Boolean) : f.callbackIps,
    depositRate: f.depositRate,
    payoutRate: f.payoutRate,
    minDepositUsd: f.minDepositUsd,
    maxDepositUsd: f.maxDepositUsd,
    minPayoutUsd: f.minPayoutUsd,
    maxPayoutUsd: f.maxPayoutUsd,
    dailyPayoutLimitUsd: f.dailyPayoutLimitUsd,
    payoutFeePct: f.payoutFeePct,
    payoutFeeFixedUsd: f.payoutFeeFixedUsd,
    autoApproveBelowUsd: f.autoApproveBelowUsd,
    payoutsToDepositPhonesOnly: f.payoutsToDepositPhonesOnly,
    ...Object.fromEntries(Object.entries(secrets).filter(([, v]) => v)),
  };
  const copy = (s: string) => void navigator.clipboard?.writeText(s).then(() => toast('success', 'Copied'));
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card title="Availability">
        <div className="space-y-2">
          <Toggle label="Accept M-Pesa deposits" checked={!!f.depositsEnabled} onChange={(v) => set('depositsEnabled', v)} />
          <Toggle label="Allow M-Pesa withdrawals" checked={!!f.payoutsEnabled} onChange={(v) => set('payoutsEnabled', v)} />
          <Toggle label="Allow trading with real-account money" checked={!!f.realTradingEnabled} onChange={(v) => set('realTradingEnabled', v)} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Badge color={c.status.depositsConfigured ? 'green' : 'amber'}>Deposits {c.status.depositsConfigured ? 'configured' : 'need credentials'}</Badge>
          <Badge color={c.status.payoutsConfigured ? 'green' : 'amber'}>Withdrawals {c.status.payoutsConfigured ? 'configured' : 'need credentials'}</Badge>
          {!c.status.callbackBaseIsHttps && <Badge color="red">Callback URL must be public HTTPS (set APP_URL / API_PUBLIC_URL)</Badge>}
          {c.status.simulatedMarketData && <Badge color="amber">Simulated market data: real-account trading blocked</Badge>}
        </div>
        <div className="mt-4 text-xs text-slate-500">Operating real-money accounts requires the relevant licences in your jurisdiction and a Safaricom paybill/till with B2C enabled.</div>
      </Card>

      <Card title="Daraja connection">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Environment">
            <select className="input" value={f.environment} onChange={(e) => set('environment', e.target.value)}>
              <option value="sandbox">Sandbox (test)</option>
              <option value="production">Production</option>
              {c.status.simulatedAllowed && <option value="simulated">Simulated (development only)</option>}
            </select>
          </Field>
          <Field label="Consumer key">{secret('consumerKey', c.secrets.consumerKey || false)}</Field>
          <Field label="Consumer secret">{secret('consumerSecret', c.secrets.consumerSecret)}</Field>
          <Field label="Account reference" hint="Shown on the customer's prompt (max 12)">{text('accountReference', 'AfeyFX')}</Field>
        </div>
        <div className="mt-3 flex gap-2">
          <button className="btn-ghost text-xs" onClick={() => void api<{ ok: boolean; message: string }>('/admin/payments/config/test', { method: 'POST' }).then((r) => toast(r.ok ? 'success' : 'error', r.ok ? 'Connection OK' : 'Connection failed', r.message), (e) => toast('error', 'Test failed', (e as Error).message))}>
            Test connection
          </button>
        </div>
      </Card>

      <Card title="Deposits — Lipa na M-Pesa (STK Push)">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Business shortcode">{text('shortcode', '174379')}</Field>
          <Field label="Passkey">{secret('passkey', c.secrets.passkey)}</Field>
          <Field label="Type">
            <select className="input" value={f.transactionType} onChange={(e) => set('transactionType', e.target.value)}>
              <option value="CustomerPayBillOnline">Paybill</option>
              <option value="CustomerBuyGoodsOnline">Buy goods (till)</option>
            </select>
          </Field>
          <Field label="Till number (buy goods only)">{text('partyB')}</Field>
          <Field label="KES charged per $1">{num('depositRate', 0.01)}</Field>
          <Field label="Min / max deposit ($)">
            <div className="flex gap-2">
              {num('minDepositUsd')}
              {num('maxDepositUsd')}
            </div>
          </Field>
        </div>
      </Card>

      <Card title="Withdrawals — B2C">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="B2C shortcode">{text('b2cShortcode', '600000')}</Field>
          <Field label="Initiator name">{text('initiatorName')}</Field>
          <Field label="Security credential" hint="Generate it in the Daraja portal from your initiator password">{secret('securityCredential', c.secrets.securityCredential)}</Field>
          <Field label="Command">
            <select className="input" value={f.b2cCommandId} onChange={(e) => set('b2cCommandId', e.target.value)}>
              <option>BusinessPayment</option>
              <option>SalaryPayment</option>
              <option>PromotionPayment</option>
            </select>
          </Field>
          <Field label="KES sent per $1">{num('payoutRate', 0.01)}</Field>
          <Field label="Fee (% / fixed $)">
            <div className="flex gap-2">
              <input className="input" type="number" step={0.1} value={((f.payoutFeePct ?? 0) * 100).toFixed(2)} onChange={(e) => set('payoutFeePct', Number(e.target.value) / 100)} />
              {num('payoutFeeFixedUsd', 0.01)}
            </div>
          </Field>
          <Field label="Min / max withdrawal ($)">
            <div className="flex gap-2">
              {num('minPayoutUsd')}
              {num('maxPayoutUsd')}
            </div>
          </Field>
          <Field label="Daily limit per trader ($)">{num('dailyPayoutLimitUsd')}</Field>
          <Field label="Auto-approve up to ($)" hint="0 = every withdrawal needs admin approval">{num('autoApproveBelowUsd')}</Field>
        </div>
        <div className="mt-3">
          <Toggle label="Only pay out to numbers that made a deposit" checked={!!f.payoutsToDepositPhonesOnly} onChange={(v) => set('payoutsToDepositPhonesOnly', v)} />
        </div>
      </Card>

      <Card title="Callback URLs (register these with Safaricom)" className="xl:col-span-2">
        <div className="space-y-2 text-xs">
          {Object.entries(c.callbackUrls).map(([k, u]) => (
            <div key={k} className="flex items-center gap-2">
              <span className="w-28 text-slate-500">{k === 'stk' ? 'STK callback' : k === 'b2cResult' ? 'B2C result' : 'B2C timeout'}</span>
              <code className="flex-1 truncate rounded bg-slate-950 px-2 py-1 text-slate-300">{u.replace(/[^/]+$/, '•••••••• (secret)')}</code>
              <button className="btn-ghost !p-1" onClick={() => copy(u)} title="Copy full URL" aria-label="Copy URL">
                <Copy size={14} />
              </button>
            </div>
          ))}
          <Field label="Allowed callback source IPs (optional, comma separated)">
            <input className="input" value={Array.isArray(f.callbackIps) ? f.callbackIps.join(', ') : String(f.callbackIps ?? '')} onChange={(e) => set('callbackIps', e.target.value)} placeholder="196.201.214.200, 196.201.214.206, …" />
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <ProtectedActionButton
            label="Save payment settings"
            className="btn-primary"
            title="Save M-Pesa settings"
            description="Changes to payment credentials and limits take effect immediately."
            endpoint="/admin/payments/config"
            method="PUT"
            body={body}
            confirmText="Save"
            onDone={() => {
              setSecrets({ consumerKey: '', consumerSecret: '', passkey: '', securityCredential: '' });
              void cfg.reload();
              void reloadFeatures();
              onSaved();
              toast('success', 'Payment settings saved');
            }}
          />
        </div>
      </Card>
    </div>
  );
}

function Transactions() {
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const list = useApi<{ payments: Payment[] }>(`/admin/payments?limit=200${type ? `&type=${type}` : ''}${status ? `&status=${status}` : ''}${q.length >= 3 ? `&q=${encodeURIComponent(q)}` : ''}`, [type, status, q]);
  const stats = useApi<Stats>('/admin/payments/stats');
  const toast = useToast();
  useSocketEvent('payment', () => {
    void list.reload();
    void stats.reload();
  });
  const done = () => {
    void list.reload();
    void stats.reload();
  };
  const s = stats.data;
  return (
    <>
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Withdrawals awaiting approval" value={s?.pendingPayouts ?? '—'} valueClass={s?.pendingPayouts ? 'text-amber-400' : ''} />
        <Stat label="Needs review" value={s?.needsReview ?? '—'} valueClass={s?.needsReview ? 'text-red-400' : ''} />
        <Stat label="Deposits (24h)" value={`$${fmtNum(s?.deposits24h.amount ?? 0)}`} sub={`${s?.deposits24h.count ?? 0} completed`} />
        <Stat label="Withdrawals (24h)" value={`$${fmtNum(s?.payouts24h.amount ?? 0)}`} sub={`${s?.payouts24h.count ?? 0} sent`} />
        <Stat label="Failed (24h)" value={s?.failed24h ?? '—'} />
      </div>
      <Card
        title="Transactions"
        actions={
          <div className="flex flex-wrap gap-2">
            <input className="input !h-8 !w-44 text-xs" placeholder="Ref, receipt or phone" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="input !h-8 !w-32 text-xs" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">All types</option>
              <option value="DEPOSIT">Deposits</option>
              <option value="PAYOUT">Withdrawals</option>
            </select>
            <select className="input !h-8 !w-36 text-xs" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              {Object.keys(STATUS_STYLE).map((k) => (
                <option key={k} value={k}>
                  {STATUS_STYLE[k].label}
                </option>
              ))}
            </select>
            <button className="btn-ghost !py-1" onClick={done} aria-label="Refresh">
              <RefreshCw size={14} />
            </button>
          </div>
        }
      >
        {list.data?.payments.length ? (
          <div className="overflow-x-auto">
            <table className="table min-w-[980px]">
              <thead>
                <tr>
                  <th>Reference</th>
                  <th>Time</th>
                  <th>Trader</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>M-Pesa</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {list.data.payments.map((p) => (
                  <tr key={p.id}>
                    <td className="font-mono text-xs">{p.reference}</td>
                    <td className="text-xs text-slate-400">{fmtTime(p.createdAt)}</td>
                    <td className="text-xs">
                      {p.userEmail}
                      {p.type === 'PAYOUT' && (
                        <div className="text-slate-500">
                          {p.firstName} {p.lastName}
                        </div>
                      )}
                    </td>
                    <td>
                      <Badge color={p.type === 'DEPOSIT' ? 'green' : 'purple'}>{p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'}</Badge>
                    </td>
                    <td className="font-mono text-xs">
                      ${fmtNum(p.amount)}
                      {p.fee > 0 && <div className="text-slate-500">fee ${fmtNum(p.fee)}</div>}
                      <div className="text-slate-500">KES {fmtNum(p.amountKes, 0)}</div>
                    </td>
                    <td className="font-mono text-xs">
                      {p.phone}
                      {p.type === 'PAYOUT' && !p.knownDestination && <div className="text-amber-400">new number</div>}
                      {p.receipt && <div className="text-slate-400">{p.receipt}</div>}
                    </td>
                    <td className="text-xs">
                      <span className={`font-semibold ${STATUS_STYLE[p.status]?.cls}`}>{STATUS_STYLE[p.status]?.label}</span>
                      {(p.resultDesc || p.reviewNote) && <div className="max-w-56 truncate text-slate-500" title={p.resultDesc ?? p.reviewNote}>{p.resultDesc ?? p.reviewNote}</div>}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {p.type === 'PAYOUT' && p.status === 'PENDING' && (
                          <>
                            <ProtectedActionButton label="Approve & send" className="btn-primary !px-2 !py-1 text-xs" title={`Send ${p.reference}`} description={`Send KES ${fmtNum(p.amountKes, 0)} to ${p.phone} (${p.firstName} ${p.lastName}) via M-Pesa B2C.`} endpoint={`/admin/payments/${p.id}/approve`} confirmText="Send money" onDone={done} />
                            <ProtectedActionButton label="Reject" className="btn-ghost !px-2 !py-1 text-xs" title={`Reject ${p.reference}`} description="The held amount is returned to the trader's account." endpoint={`/admin/payments/${p.id}/reject`} extraFields={[{ name: 'note', label: 'Reason shown to the trader', placeholder: 'e.g. Please verify your identity' }]} confirmText="Reject" onDone={done} />
                          </>
                        )}
                        {p.status === 'UNCERTAIN' && (
                          <>
                            <ProtectedActionButton label="Mark completed" className="btn-primary !px-2 !py-1 text-xs" title={`Resolve ${p.reference} as completed`} description={p.type === 'DEPOSIT' ? 'Only if the payment is on your M-Pesa statement. The trader is credited once.' : 'Only if the money left your M-Pesa account (check the statement).'} endpoint={`/admin/payments/${p.id}/resolve`} body={{ outcome: 'COMPLETED' }} extraFields={[{ name: 'receipt', label: 'M-Pesa receipt (optional)', placeholder: 'QKX1234567' }, { name: 'note', label: 'Note', placeholder: 'Checked against statement' }]} confirmText="Mark completed" onDone={done} />
                            <ProtectedActionButton label="Mark failed" className="btn-danger !px-2 !py-1 text-xs" title={`Resolve ${p.reference} as failed`} description={p.type === 'PAYOUT' ? 'The held amount is refunded to the trader.' : 'The trader is not credited.'} endpoint={`/admin/payments/${p.id}/resolve`} body={{ outcome: 'FAILED' }} extraFields={[{ name: 'note', label: 'Note', placeholder: 'Not on statement' }]} confirmText="Mark failed" onDone={done} />
                          </>
                        )}
                        {p.type === 'DEPOSIT' && (p.status === 'PENDING' || p.status === 'UNCERTAIN') && (
                          <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => void api(`/admin/payments/${p.id}/requery`, { method: 'POST' }).then(done, (e) => toast('error', 'Query failed', (e as Error).message))}>
                            Check status
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{list.loading ? 'Loading…' : 'No transactions'}</Empty>
        )}
      </Card>
    </>
  );
}

/** Admin payments console: transactions + review queue, and the M-Pesa configuration. */
export function AdminPaymentsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Transactions');
  return (
    <div className="p-4">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-slate-50">Payments (M-Pesa)</h1>
        <Tabs tabs={TABS} value={tab} onChange={setTab} />
      </div>
      {tab === 'Transactions' ? <Transactions /> : <Settings onSaved={() => undefined} />}
    </div>
  );
}
