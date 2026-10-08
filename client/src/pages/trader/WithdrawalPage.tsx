import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ChevronDown } from 'lucide-react';
import { AccountTabs, STATUS_STYLE } from '../../components/AccountTabs';
import { ConfirmCodeModal } from '../../components/ConfirmCodeModal';
import { MpesaLogo } from '../../components/payments/MpesaLogo';
import { useToast } from '../../components/Toaster';
import { useAuth } from '../../hooks/useAuth';
import { useTrader } from '../../hooks/useTrader';
import { useApi } from '../../hooks/useApi';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { api } from '../../services/api';
import { fmtNum, fmtTime } from '../../utils/format';
import type { Payment } from '../../types';

function Outlined({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-lg border border-slate-600 px-4 pt-0 pb-2 focus-within:border-sky-500">
      <legend className="px-1 text-sm text-slate-400">{label}</legend>
      {children}
    </fieldset>
  );
}

export function WithdrawalPage() {
  const { accounts, payConfig, reloadAccount } = useTrader();
  const { user } = useAuth();
  const toast = useToast();
  const real = accounts.REAL;
  const cfg = payConfig?.payouts;
  const history = useApi<{ payments: Payment[] }>('/payments?type=PAYOUT&limit=10');
  useSocketEvent('payment', () => void history.reload());
  const [amount, setAmount] = useState(10);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const n = (user?.name ?? '').trim().split(/\s+/);
    if (!first && n.length > 1) {
      setFirst(n[0].toUpperCase());
      setLast(n.slice(1).join(' ').toUpperCase());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const quote = useMemo(() => {
    if (!cfg) return null;
    const fee = Math.round(amount * 100 * cfg.feePct) / 100 + cfg.feeFixedUsd;
    const net = Math.max(0, amount - fee);
    return { fee, net, kes: Math.floor(net * cfg.rate) };
  }, [amount, cfg]);

  const available = real?.balance ?? 0;
  const problems = !cfg?.enabled ? 'Withdrawals are temporarily unavailable' : amount < (cfg?.minUsd ?? 0) ? `Minimum withdrawal is $${cfg?.minUsd}` : amount > (cfg?.maxUsd ?? 0) ? `Maximum withdrawal is $${cfg?.maxUsd}` : amount > available + 1e-9 ? 'Amount exceeds your available balance' : !first.trim() || !last.trim() ? 'Enter your first and last name' : !/^(\+?254|0)?[17]\d{8}$/.test(phone.replace(/\s/g, '')) ? 'Enter your M-Pesa number' : null;

  const submit = async (code: { totp?: string; emailCode?: string }) => {
    await api('/payments/payouts', { method: 'POST', body: { amount, phone, firstName: first, lastName: last, idempotencyKey: crypto.randomUUID(), ...code } });
    setConfirm(false);
    toast('success', 'Withdrawal requested', `$${fmtNum(amount)} to ${phone}. You'll be notified when it is sent.`);
    await Promise.all([reloadAccount(), history.reload()]);
  };

  const cancel = async (id: string) => {
    try {
      await api(`/payments/payouts/${id}/cancel`, { method: 'POST' });
      toast('success', 'Withdrawal cancelled', 'The amount is back in your account.');
      await Promise.all([reloadAccount(), history.reload()]);
    } catch (e) {
      toast('error', 'Could not cancel', (e as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <AccountTabs />
      <div className="grid overflow-hidden rounded-2xl bg-slate-900 ring-1 ring-slate-800 md:grid-cols-[1fr_1.6fr]">
        <section className="border-b border-dashed border-slate-700 p-6 md:border-r md:border-b-0">
          <h2 className="text-xl font-bold text-slate-50">Account:</h2>
          <div className="mt-8 space-y-8 pl-6">
            <div>
              <div className="text-slate-400">In the account:</div>
              <div className="mt-1 font-mono text-3xl font-bold text-slate-50">{fmtNum(real?.equity ?? 0)} $</div>
            </div>
            <div className="border-t border-slate-800 pt-8">
              <div className="text-slate-400">Available for withdrawal:</div>
              <div className="mt-1 font-mono text-3xl font-bold text-slate-50">{fmtNum(available)} $</div>
              {(real?.equity ?? 0) - available > 0.005 && <div className="mt-1 text-xs text-slate-500">Funds in open trades are not withdrawable.</div>}
            </div>
          </div>
        </section>
        <section className="p-6">
          <h2 className="text-xl font-bold text-slate-50">Withdrawal:</h2>
          <div className="mt-6 grid gap-5 sm:grid-cols-2">
            <Outlined label="Amount">
              <div className="flex items-center">
                <input className="h-11 w-full bg-transparent font-mono text-xl text-slate-50 outline-none" inputMode="decimal" value={amount} onChange={(e) => setAmount(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} aria-label="Amount" />
                <span className="text-lg text-slate-500">USD</span>
              </div>
            </Outlined>
            <Outlined label="Payment method">
              <div className="flex h-11 items-center gap-3 text-lg text-slate-50">
                <MpesaLogo small /> M-pesa <ChevronDown size={18} className="ml-auto text-slate-400" />
              </div>
            </Outlined>
          </div>
          <div className="mt-5 grid gap-5">
            <Outlined label="First name">
              <input className="h-11 w-full bg-transparent text-lg text-slate-50 uppercase outline-none" value={first} onChange={(e) => setFirst(e.target.value.toUpperCase())} aria-label="First name" autoComplete="given-name" />
            </Outlined>
            <Outlined label="Last name">
              <input className="h-11 w-full bg-transparent text-lg text-slate-50 uppercase outline-none" value={last} onChange={(e) => setLast(e.target.value.toUpperCase())} aria-label="Last name" autoComplete="family-name" />
            </Outlined>
            <Outlined label="Phone">
              <input className="h-11 w-full bg-transparent font-mono text-lg text-slate-50 outline-none placeholder:text-slate-600" placeholder="254XXXXXXXXX" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="Phone" />
            </Outlined>
          </div>
          {cfg?.depositPhonesOnly && <div className="mt-2 text-xs text-slate-500">For your security, withdrawals go to an M-Pesa number you have deposited from.</div>}
          {quote && (
            <div className="mt-5 grid grid-cols-3 gap-2 rounded-xl bg-slate-950 p-3 text-sm ring-1 ring-slate-800">
              <div>
                <div className="text-slate-500">Fee</div>
                <div className="font-mono text-slate-200">${fmtNum(quote.fee)}</div>
              </div>
              <div>
                <div className="text-slate-500">You receive</div>
                <div className="font-mono text-slate-200">${fmtNum(quote.net)}</div>
              </div>
              <div>
                <div className="text-slate-500">To M-Pesa</div>
                <div className="font-mono font-bold text-emerald-400">KES {fmtNum(quote.kes, 0)}</div>
              </div>
            </div>
          )}
          {problems && amount > 0 && <div className="mt-3 text-sm text-amber-400">{problems}</div>}
          <button className="mt-6 flex h-14 w-full items-center justify-between rounded-lg bg-sky-600 px-6 text-lg font-bold text-white shadow-lg shadow-sky-900/30 hover:bg-sky-500 disabled:opacity-50 sm:w-80" disabled={!!problems} onClick={() => setConfirm(true)}>
            Confirm <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20"><ArrowRight size={18} /></span>
          </button>
        </section>
      </div>

      <section className="mt-6 rounded-2xl bg-slate-900 p-5 ring-1 ring-slate-800">
        <h3 className="mb-3 text-lg font-bold text-slate-100">Some of your latest requests:</h3>
        {history.data?.payments.length ? (
          <div className="divide-y divide-slate-800">
            {history.data.payments.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-x-6 gap-y-1 py-3 text-sm">
                <span className="font-mono text-slate-300">{p.reference}</span>
                <span className="text-slate-400">{fmtTime(p.createdAt)}</span>
                <span className={`font-semibold ${STATUS_STYLE[p.status]?.cls}`}>{STATUS_STYLE[p.status]?.label ?? p.status}</span>
                <span className="text-slate-400">{p.phone}</span>
                <span className="ml-auto font-mono font-semibold text-red-400">-${fmtNum(p.amount)}</span>
                {p.status === 'PENDING' && (
                  <button className="btn-ghost !py-1 text-xs" onClick={() => void cancel(p.id)}>
                    Cancel
                  </button>
                )}
                {p.message && <div className="w-full text-xs text-slate-500">{p.message}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-sm text-slate-500">No withdrawal requests yet.</div>
        )}
      </section>

      <ConfirmCodeModal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Confirm withdrawal"
        context="Withdrawal to M-Pesa"
        confirmText={`Withdraw $${fmtNum(amount)}`}
        description={
          <>
            Withdraw <b>${fmtNum(amount)}</b> to M-Pesa <b>{phone}</b> ({first} {last}). You will receive <b>KES {fmtNum(quote?.kes ?? 0, 0)}</b>.
          </>
        }
        onConfirm={submit}
      />
    </div>
  );
}
