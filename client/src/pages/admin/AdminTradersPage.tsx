import { useMemo, useState, type ReactNode } from 'react';
import { RefreshCw, Search, ShieldOff, UserX } from 'lucide-react';
import { Badge, Card, Empty, ErrorText, Modal, Stat, Tabs } from '../../components/ui';
import { ProtectedActionButton } from '../../components/ProtectedActionButton';
import { useToast } from '../../components/Toaster';
import { useApi } from '../../hooks/useApi';
import { api } from '../../services/api';
import { fmtNum, fmtPct, fmtTime, pnlClass } from '../../utils/format';
import type { Payment, Position, Trade, User } from '../../types';

type Status = 'active' | 'suspended' | 'disabled' | 'deleted';
interface AcctSummary {
  exists: boolean;
  balance: number;
  equity: number;
  openPositions: number;
  trades: number;
  netPnl: number;
  winRate: number | null;
  lastTradeAt: string | null;
}
interface TraderRow {
  id: string;
  email: string;
  name: string;
  role: string;
  status: Status;
  suspendedUntil: string | null;
  statusReason: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  demo: AcctSummary;
  real: AcctSummary & { deposited: number; withdrawn: number };
}
interface AccountView {
  balance: number;
  equity: number;
  available: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl?: number;
  drawdown: number;
  startingBalance: number;
}
interface Detail {
  user: User & { status: Status; createdAt?: string };
  accounts: { DEMO: AccountView | null; REAL: AccountView | null };
  openPositions: Position[];
  trades: Trade[];
  payments: Payment[];
  brokerConnections: { id: string; providerName: string; label?: string; accountId: string | null; environment: string; status: string; tradingEnabled: boolean; balance: number | null; currency: string | null }[];
}

const STATUS_COLOR: Record<Status, 'green' | 'amber' | 'red' | 'slate'> = { active: 'green', suspended: 'amber', disabled: 'red', deleted: 'slate' };
const modeLabel = (m: string) => (m === 'REAL' || m === 'LIVE' ? 'Real' : m === 'DEMO' ? 'Broker demo' : 'Demo');
const money = (v?: number | null) => (v === null || v === undefined ? '—' : `$${fmtNum(v)}`);

function StatusBadge({ s, until }: { s: Status; until?: string | null }) {
  return (
    <Badge color={STATUS_COLOR[s]}>
      {s}
      {s === 'suspended' && until ? ` until ${new Date(until).toLocaleDateString()}` : ''}
    </Badge>
  );
}

/** Small dialog for non-protected actions that need a reason (suspend, disable). */
function ReasonDialog({ open, title, children, withDays, confirmText, danger, onClose, onConfirm }: { open: boolean; title: string; children?: ReactNode; withDays?: boolean; confirmText: string; danger?: boolean; onClose(): void; onConfirm(v: { reason: string; days?: number }): Promise<void> }) {
  const [reason, setReason] = useState('');
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await onConfirm({ reason, ...(withDays ? { days } : {}) });
            setReason('');
            onClose();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {children && <div className="text-sm text-slate-300">{children}</div>}
        {withDays && (
          <div>
            <label className="label">Suspend for</label>
            <div className="flex flex-wrap gap-1.5">
              {[1, 3, 7, 14, 30, 90].map((d) => (
                <button type="button" key={d} onClick={() => setDays(d)} className={`rounded-lg px-3 py-1 text-xs font-semibold ${days === d ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300'}`}>
                  {d} day{d > 1 ? 's' : ''}
                </button>
              ))}
            </div>
          </div>
        )}
        <div>
          <label className="label">Reason (recorded in the audit log; emailed to the user when email is set up)</label>
          <textarea className="input min-h-20" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required minLength={3} />
        </div>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy || reason.trim().length < 3}>
            {busy ? 'Working…' : confirmText}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** A strong random temporary password (works on plain http too). */
function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const b = new Uint32Array(14);
  crypto.getRandomValues(b);
  const body = [...b].map((x) => chars[x % chars.length]).join('');
  return `${body.slice(0, 7)}-${body.slice(7)}A9`;
}

const DETAIL_TABS = ['Overview', 'Open positions', 'Trades', 'Payments', 'Brokers'] as const;

function TraderDetail({ id, onChanged }: { id: string; onChanged(): void }) {
  const toast = useToast();
  const d = useApi<Detail>(`/admin/traders/${id}`, [id]);
  const [tab, setTab] = useState<(typeof DETAIL_TABS)[number]>('Overview');
  const [dialog, setDialog] = useState<'suspend' | 'disable' | null>(null);
  const [pw, setPw] = useState('');
  const refresh = () => {
    void d.reload();
    onChanged();
  };
  const act = async (path: string, body?: unknown) => {
    await api(`/admin/traders/${id}/${path}`, { method: 'POST', body: body ?? {} });
    refresh();
  };
  if (!d.data) return <div className="p-4 text-sm text-slate-500">{d.error ?? 'Loading…'}</div>;
  const { user: u, accounts } = d.data;
  const s = u.status;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-bold text-slate-50">{u.name}</h2>
            <StatusBadge s={s} until={u.suspendedUntil} />
            <Badge color={u.role === 'admin' ? 'purple' : 'blue'}>{u.role}</Badge>
            {!u.emailVerified && <Badge color="amber">email not verified</Badge>}
            {u.twoFactorEnabled && <Badge color="green">2FA</Badge>}
            {u.mustChangePassword && <Badge color="amber">temporary password</Badge>}
          </div>
          <div className="mt-1 text-sm text-slate-400">
            {u.email} · joined {fmtTime(u.createdAt)} · last login {fmtTime(u.lastLoginAt)}
          </div>
          {u.statusReason && s !== 'active' && <div className="mt-1 text-xs text-amber-300">Reason: {u.statusReason}</div>}
        </div>
        <button className="btn-ghost !py-1 text-xs" onClick={refresh}>
          <RefreshCw size={12} className="mr-1 inline" /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 border-y border-slate-800 py-3">
        {!u.emailVerified && s !== 'deleted' && (
          <button className="btn-ghost !py-1 text-xs text-sky-300" onClick={() => api(`/users/${id}/verify-email`, { method: 'POST', body: { verified: true } }).then(() => (toast('success', 'Email verified'), refresh()), (e) => toast('error', 'Failed', (e as Error).message))}>
            Verify email
          </button>
        )}
        {s === 'suspended' ? (
          <button className="btn-ghost !py-1 text-xs" onClick={() => act('unsuspend').then(() => toast('success', 'Suspension lifted'), (e) => toast('error', 'Failed', (e as Error).message))}>
            Lift suspension
          </button>
        ) : (
          s !== 'deleted' && (
            <button className="btn-ghost !py-1 text-xs text-amber-300" onClick={() => setDialog('suspend')}>
              Suspend…
            </button>
          )
        )}
        {s === 'disabled' ? (
          <button className="btn-ghost !py-1 text-xs" onClick={() => act('enable').then(() => toast('success', 'Account enabled'), (e) => toast('error', 'Failed', (e as Error).message))}>
            Enable account
          </button>
        ) : (
          s !== 'deleted' && (
            <button className="btn-ghost !py-1 text-xs text-red-300" onClick={() => setDialog('disable')}>
              Disable…
            </button>
          )
        )}
        {s !== 'deleted' && (
          <span onClick={() => !pw && setPw(tempPassword())}>
            <ProtectedActionButton
              label="Reset password…"
              className="btn-ghost !py-1 text-xs"
              title="Reset password"
              description={
                <div className="space-y-2">
                  <p>
                    Set a temporary password for <b>{u.email}</b>. All their sessions end, login locks are cleared, and they are asked to choose a new password after signing in.
                  </p>
                  <p className="text-xs text-slate-400">Give the temporary password to the user privately. It is not stored in plain text and won't be shown again.</p>
                  <div className="flex gap-2">
                    <input className="input font-mono" value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Temporary password" />
                    <button type="button" className="btn-ghost !px-2 text-xs" onClick={() => setPw(tempPassword())}>
                      New
                    </button>
                    <button type="button" className="btn-ghost !px-2 text-xs" onClick={() => navigator.clipboard?.writeText(pw).then(() => toast('success', 'Copied'))}>
                      Copy
                    </button>
                  </div>
                </div>
              }
              endpoint={`/admin/traders/${id}/reset-password`}
              body={{ password: pw }}
              confirmText="Reset password"
              onDone={() => {
                toast('success', 'Password reset', 'Share the temporary password with the user privately.');
                refresh();
              }}
            />
          </span>
        )}
        {s === 'deleted' ? (
          <ProtectedActionButton label="Restore account…" className="btn-ghost !py-1 text-xs" title="Restore account" description={`Restore ${u.email}. They can sign in again with their existing password.`} endpoint={`/admin/traders/${id}/restore`} confirmText="Restore" onDone={() => (toast('success', 'Account restored'), refresh())} />
        ) : (
          <ProtectedActionButton
            label={
              <>
                <UserX size={12} className="mr-1 inline" />
                Delete account…
              </>
            }
            className="btn-danger !py-1 text-xs"
            title="Delete account (soft delete)"
            description={
              <div className="space-y-1">
                <p>
                  <b>{u.email}</b> will no longer be able to sign in. Their trades, payments and audit history are kept, and you can restore the account later.
                </p>
                <p className="text-xs text-amber-300">Refused while they have open positions, unfinished payments or real money in their account.</p>
              </div>
            }
            extraFields={[
              { name: 'reason', label: 'Reason', placeholder: 'e.g. Closed at the customer’s request' },
              { name: 'confirm', label: 'Type DELETE to confirm', placeholder: 'DELETE' },
            ]}
            endpoint={`/admin/traders/${id}/delete`}
            confirmText="Delete account"
            onDone={() => (toast('success', 'Account deleted'), refresh())}
          />
        )}
      </div>

      <Tabs tabs={DETAIL_TABS} value={tab} onChange={setTab} />
      {tab === 'Overview' && (
        <div className="space-y-3">
          {(['DEMO', 'REAL'] as const).map((k) => {
            const a = accounts[k];
            return (
              <div key={k}>
                <div className="mb-1 text-xs font-semibold tracking-wide text-slate-400 uppercase">{k === 'REAL' ? 'Live account (real money)' : 'Demo account'}</div>
                {a ? (
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
                    <Stat label="Balance" value={money(a.balance)} />
                    <Stat label="Equity" value={money(a.equity)} />
                    <Stat label="Open P&L" value={fmtNum(a.unrealizedPnl)} valueClass={pnlClass(a.unrealizedPnl)} />
                    <Stat label="Realized P&L" value={fmtNum(a.realizedPnl)} valueClass={pnlClass(a.realizedPnl)} />
                    <Stat label="Drawdown" value={fmtPct(a.drawdown)} />
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">No account yet</div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {tab === 'Open positions' && (
        <Table
          rows={d.data.openPositions}
          empty="No open positions"
          cols={[
            ['Opened', (p) => fmtTime(p.openedAt)],
            ['Account', (p) => modeLabel(p.mode)],
            ['Symbol', (p) => p.symbol],
            ['Side', (p) => <Badge color={p.direction === 'LONG' ? 'green' : 'red'}>{p.direction}</Badge>],
            ['Size', (p) => (p.lots ? `${fmtNum(p.lots, 2)} lot` : fmtNum(p.amount, 4))],
            ['Entry', (p) => fmtNum(p.entryPrice, 5)],
            ['Open P&L', (p) => <span className={pnlClass(p.unrealizedPnl)}>{fmtNum(p.unrealizedPnl)}</span>],
          ]}
        />
      )}
      {tab === 'Trades' && (
        <Table
          rows={d.data.trades}
          empty="No closed trades"
          cols={[
            ['Closed', (t) => fmtTime(t.closedAt)],
            ['Account', (t) => modeLabel(t.mode)],
            ['Symbol', (t) => t.symbol],
            ['Side', (t) => t.direction],
            ['Entry → exit', (t) => `${fmtNum(t.entryPrice, 5)} → ${fmtNum(t.exitPrice, 5)}`],
            ['Net P&L', (t) => <span className={pnlClass(t.netPnl)}>{fmtNum(t.netPnl)}</span>],
            ['Reason', (t) => t.exitReason ?? ''],
          ]}
        />
      )}
      {tab === 'Payments' && (
        <Table
          rows={d.data.payments}
          empty="No deposits or withdrawals"
          cols={[
            ['Date', (p) => fmtTime(p.createdAt)],
            ['Type', (p) => (p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal')],
            ['Amount', (p) => money(p.amount)],
            ['KES', (p) => fmtNum(p.amountKes, 0)],
            ['Status', (p) => <Badge color={p.status === 'COMPLETED' ? 'green' : p.status === 'PENDING' || p.status === 'PROCESSING' ? 'amber' : 'red'}>{p.status}</Badge>],
            ['Phone', (p) => <span className="font-mono">{p.phone}</span>],
            ['Receipt', (p) => p.receipt ?? '—'],
          ]}
        />
      )}
      {tab === 'Brokers' && (
        <Table
          rows={d.data.brokerConnections}
          empty="No broker accounts connected"
          cols={[
            ['Broker', (c) => c.label || c.providerName],
            ['Account', (c) => <span className="font-mono">{c.accountId ?? '—'}</span>],
            ['Type', (c) => <Badge color={c.environment === 'real' ? 'red' : 'amber'}>{c.environment}</Badge>],
            ['Status', (c) => c.status],
            ['Trading', (c) => (c.tradingEnabled ? 'on' : 'off')],
            ['Balance', (c) => (c.balance !== null ? `${fmtNum(c.balance)} ${c.currency ?? ''}` : '—')],
          ]}
        />
      )}

      <ReasonDialog open={dialog === 'suspend'} title={`Suspend ${u.email}`} withDays confirmText="Suspend" onClose={() => setDialog(null)} onConfirm={(v) => act('suspend', v).then(() => toast('success', 'Account suspended'))}>
        They are signed out at once and can't sign in or trade until the suspension ends. Open positions stay open (their stops still apply).
      </ReasonDialog>
      <ReasonDialog open={dialog === 'disable'} title={`Disable ${u.email}`} confirmText="Disable account" danger onClose={() => setDialog(null)} onConfirm={(v) => act('disable', v).then(() => toast('success', 'Account disabled'))}>
        They are signed out at once and can't sign in until an administrator enables the account again.
      </ReasonDialog>
    </div>
  );
}

function Table<T>({ rows, cols, empty }: { rows: T[] | undefined; cols: [string, (r: T) => ReactNode][]; empty: string }) {
  if (!rows?.length) return <Empty>{empty}</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            {cols.map(([h]) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map(([h, f]) => (
                <td key={h} className="font-sans">
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

const FILTERS = ['All', 'Active', 'Suspended', 'Disabled', 'Deleted'] as const;

export function AdminTradersPage() {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('All');
  const [selected, setSelected] = useState<string | null>(null);
  const list = useApi<{ traders: TraderRow[] }>(`/admin/traders?status=${filter === 'Deleted' ? 'deleted' : ''}&q=${encodeURIComponent(q)}`, [q, filter]);
  const rows = useMemo(() => (list.data?.traders ?? []).filter((t) => filter === 'All' || filter === 'Deleted' || t.status === filter.toLowerCase()), [list.data, filter]);
  const totals = useMemo(() => {
    const all = list.data?.traders ?? [];
    return { n: all.length, real: all.reduce((s, t) => s + t.real.balance, 0), deposits: all.reduce((s, t) => s + t.real.deposited, 0), open: all.reduce((s, t) => s + t.demo.openPositions + t.real.openPositions, 0) };
  }, [list.data]);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Traders" value={totals.n} />
        <Stat label="Real-money balances" value={money(totals.real)} />
        <Stat label="Completed deposits" value={money(totals.deposits)} />
        <Stat label="Open positions" value={totals.open} />
      </div>
      <Card
        title="Traders"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={14} className="absolute top-1/2 left-2 -translate-y-1/2 text-slate-500" />
              <input className="input !w-56 !py-1 !pl-7 text-sm" placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="flex rounded-lg bg-slate-950 p-0.5 text-xs">
              {FILTERS.map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={`rounded-md px-2 py-1 ${filter === f ? 'bg-slate-700 text-slate-50' : 'text-slate-400'}`}>
                  {f}
                </button>
              ))}
            </div>
          </div>
        }
      >
        <ErrorText error={list.error} />
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Trader</th>
                  <th>Status</th>
                  <th>Demo balance</th>
                  <th>Demo P&L</th>
                  <th>Real balance</th>
                  <th>Real P&L</th>
                  <th>Deposited / withdrawn</th>
                  <th>Open</th>
                  <th>Last login</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id} className="cursor-pointer hover:bg-slate-800/40" onClick={() => setSelected(t.id)}>
                    <td className="font-sans">
                      <div className="font-semibold text-slate-100">{t.name}</div>
                      <div className="text-xs text-slate-500">
                        {t.email}
                        {!t.emailVerified && <span className="text-amber-400"> · unverified</span>}
                        {t.role === 'admin' && <span className="text-violet-300"> · admin</span>}
                      </div>
                    </td>
                    <td>
                      <StatusBadge s={t.status} until={t.suspendedUntil} />
                    </td>
                    <td>{t.demo.exists ? money(t.demo.equity) : '—'}</td>
                    <td className={pnlClass(t.demo.netPnl)}>
                      {fmtNum(t.demo.netPnl)}
                      {t.demo.trades ? <span className="text-slate-500"> · {t.demo.trades} tr</span> : null}
                    </td>
                    <td>{t.real.exists ? money(t.real.equity) : '—'}</td>
                    <td className={pnlClass(t.real.netPnl)}>{fmtNum(t.real.netPnl)}</td>
                    <td>
                      {money(t.real.deposited)} / {money(t.real.withdrawn)}
                    </td>
                    <td>{t.demo.openPositions + t.real.openPositions}</td>
                    <td>{fmtTime(t.lastLoginAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>{list.loading ? 'Loading…' : 'No traders match'}</Empty>
        )}
        <p className="mt-3 flex items-center gap-1 text-xs text-slate-500">
          <ShieldOff size={12} /> Read-only view: administrators can't trade or move money on a trader's behalf. Every account view and action is audited.
        </p>
      </Card>
      <Modal open={!!selected} onClose={() => setSelected(null)} title="Trader" wide>
        {selected && <TraderDetail id={selected} onChanged={() => void list.reload()} />}
      </Modal>
    </div>
  );
}
