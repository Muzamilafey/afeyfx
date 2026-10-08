import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, ChevronRight, Clock, Flame, Loader2, Smartphone, Wallet, X, XCircle } from 'lucide-react';
import { api } from '../../services/api';
import { useTrader } from '../../hooks/useTrader';
import { fmtNum } from '../../utils/format';
import { MpesaLogo } from './MpesaLogo';
import type { Payment } from '../../types';

const PRESETS = [10, 20, 50, 100, 250, 500];
const LAST_KEY = 'afx-last-deposit';

interface Last {
  amount: number;
  phone: string;
}
const readLast = (): Last | null => {
  try {
    return JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null');
  } catch {
    return null;
  }
};

const CATEGORIES = [
  { id: 'popular', title: 'POPULAR', icon: Flame },
  { id: 'epay', title: 'E-PAY', icon: Wallet },
] as const;

/**
 * Deposit dialog (M-Pesa STK Push). Step 1: choose a method; step 2: amount + phone; step 3: the
 * customer approves the prompt on their phone while we follow the transaction status live.
 */
export function DepositModal() {
  const { depositOpen, closeDeposit, payConfig, lastPayment, setAccountType } = useTrader();
  const [cat, setCat] = useState<'popular' | 'epay'>('popular');
  const [step, setStep] = useState<'methods' | 'form' | 'waiting'>('methods');
  const last = useMemo(readLast, [depositOpen]);
  const [amount, setAmount] = useState(last?.amount ?? 50);
  const [phone, setPhone] = useState(last?.phone ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payment, setPayment] = useState<Payment | null>(null);

  useEffect(() => {
    if (!depositOpen) {
      setStep('methods');
      setPayment(null);
      setError(null);
    }
  }, [depositOpen]);

  // Follow the transaction: socket updates, with polling as a fallback.
  useEffect(() => {
    if (lastPayment && payment && lastPayment.id === payment.id) setPayment(lastPayment);
  }, [lastPayment, payment]);
  useEffect(() => {
    if (step !== 'waiting' || !payment || payment.status !== 'PENDING') return;
    const t = setInterval(() => void api<{ payment: Payment }>(`/payments/${payment.id}`).then((r) => setPayment(r.payment), () => undefined), 4000);
    return () => clearInterval(t);
  }, [step, payment]);

  if (!depositOpen) return null;
  const cfg = payConfig?.deposits;
  const kes = cfg ? Math.ceil(amount * 100 * cfg.rate) / 100 : 0;
  const valid = !!cfg && amount >= cfg.minUsd && amount <= cfg.maxUsd && /^(\+?254|0)?[17]\d{8}$/.test(phone.replace(/\s/g, ''));

  const submit = async (a = amount, p = phone) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ payment: Payment }>('/payments/deposits', { method: 'POST', body: { amount: a, phone: p, idempotencyKey: crypto.randomUUID() } });
      setPayment(r.payment);
      setStep('waiting');
      try {
        localStorage.setItem(LAST_KEY, JSON.stringify({ amount: a, phone: p }));
      } catch {
        /* ignore */
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const methodCard = (label: string, opts: { repeat?: boolean } = {}) => (
    <button
      key={label}
      onClick={() => setStep('form')}
      className="group flex items-center gap-3 rounded-lg bg-white px-4 py-3 text-left text-slate-900 shadow-sm ring-1 ring-slate-200 transition hover:ring-2 hover:ring-emerald-500 [html.light_&]:bg-slate-50"
    >
      <MpesaLogo />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[15px] font-medium text-slate-900">{label}</div>
        {opts.repeat && last ? (
          <span className="mt-0.5 inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
            <Clock size={11} /> Last used
          </span>
        ) : (
          <div className="text-xs text-slate-500">Min. ${fmtNum(cfg?.minUsd ?? 10)}</div>
        )}
      </div>
      {opts.repeat && last ? (
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            setAmount(last.amount);
            setPhone(last.phone);
            void submit(last.amount, last.phone);
          }}
          className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-bold text-white shadow hover:bg-emerald-600"
        >
          Repeat
        </span>
      ) : (
        <ChevronRight size={18} className="text-slate-400 group-hover:text-slate-600" />
      )}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm sm:p-6" role="dialog" aria-modal="true" aria-label="Deposit">
      <div className="flex max-h-full w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-dashed border-slate-700 px-6 py-5">
          <h2 className="text-2xl font-bold text-slate-50">Deposit</h2>
          <button onClick={closeDeposit} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100" aria-label="Close">
            <X size={24} />
          </button>
        </div>

        {step === 'methods' && (
          <div className="grid min-h-0 flex-1 gap-5 overflow-auto p-6 md:grid-cols-[320px_1fr]">
            <div className="flex flex-col gap-3">
              {CATEGORIES.map((c) => (
                <button key={c.id} onClick={() => setCat(c.id)} className={`rounded-xl p-4 text-left ring-1 transition ${cat === c.id ? 'bg-emerald-500 text-white ring-emerald-400' : 'bg-slate-800/60 text-slate-200 ring-slate-700 hover:ring-slate-500'}`}>
                  <div className="flex items-center gap-3">
                    <c.icon size={22} />
                    <div>
                      <div className="font-bold">{c.title}</div>
                      <div className={`text-sm ${cat === c.id ? 'text-emerald-50' : 'text-slate-400'}`}>1 method</div>
                    </div>
                  </div>
                  <div className="mt-3 flex gap-2 pl-9">
                    <MpesaLogo small />
                  </div>
                </button>
              ))}
              <div className="rounded-xl bg-slate-800/40 p-3 text-xs text-slate-400 ring-1 ring-slate-800">
                Funds go to your <b className="text-slate-200">Real account</b> in USD at KES {fmtNum(cfg?.rate ?? 0)} per $1. More methods coming soon.
              </div>
            </div>
            <div>
              <h3 className="mb-3 text-lg font-bold text-slate-100">{cat === 'popular' ? 'Popular in your region' : 'E-Pay'}</h3>
              {!cfg?.enabled ? (
                <div className="rounded-xl bg-amber-500/10 p-4 text-sm text-amber-300 ring-1 ring-amber-500/30">Deposits are temporarily unavailable.</div>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {cat === 'popular' && last && methodCard('M-Pesa (Instant Pay)', { repeat: true })}
                  {methodCard('M-Pesa (Instant Pay)')}
                </div>
              )}
              {payConfig?.sandbox && <div className="mt-4 text-xs text-amber-400">Sandbox mode: no real money moves.</div>}
            </div>
          </div>
        )}

        {step === 'form' && cfg && (
          <div className="mx-auto w-full max-w-md overflow-auto p-6">
            <button className="mb-4 text-sm text-sky-400 hover:underline" onClick={() => setStep('methods')}>
              ← All methods
            </button>
            <div className="mb-5 flex items-center gap-3">
              <MpesaLogo />
              <div>
                <div className="font-bold text-slate-50">M-Pesa (Instant Pay)</div>
                <div className="text-xs text-slate-400">
                  Min ${fmtNum(cfg.minUsd)} · Max ${fmtNum(cfg.maxUsd)} · Instant
                </div>
              </div>
            </div>
            <label className="label">Amount (USD)</label>
            <div className="flex items-center rounded-xl bg-slate-950 px-3 ring-1 ring-slate-700 focus-within:ring-sky-500">
              <span className="text-xl text-slate-400">$</span>
              <input className="h-14 w-full bg-transparent px-2 font-mono text-2xl font-bold text-slate-50 outline-none" inputMode="decimal" value={amount} onChange={(e) => setAmount(Number(e.target.value.replace(/[^0-9.]/g, '')) || 0)} aria-label="Amount in USD" />
            </div>
            <div className="mt-2 grid grid-cols-6 gap-1.5">
              {PRESETS.map((p) => (
                <button key={p} type="button" onClick={() => setAmount(p)} className={`rounded-lg py-1.5 text-xs font-bold ${amount === p ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
                  ${p}
                </button>
              ))}
            </div>
            <div className="mt-2 text-sm text-slate-400">
              You pay <b className="font-mono text-slate-100">KES {fmtNum(kes, 0)}</b>
            </div>
            <label className="label mt-4">M-Pesa phone number</label>
            <div className="flex items-center rounded-xl bg-slate-950 px-3 ring-1 ring-slate-700 focus-within:ring-sky-500">
              <Smartphone size={18} className="text-slate-500" />
              <input className="h-12 w-full bg-transparent px-2 font-mono text-lg text-slate-50 outline-none" inputMode="tel" placeholder="07XX XXX XXX" value={phone} onChange={(e) => setPhone(e.target.value)} aria-label="M-Pesa phone number" autoComplete="tel" />
            </div>
            {error && <div className="mt-3 rounded-lg bg-red-500/10 p-2 text-sm text-red-400">{error}</div>}
            <button className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 font-bold text-white shadow-lg shadow-emerald-900/30 hover:bg-emerald-600 disabled:opacity-50" disabled={!valid || busy} onClick={() => void submit()}>
              {busy ? <Loader2 className="animate-spin" size={18} /> : null} Pay KES {fmtNum(kes, 0)} with M-Pesa
            </button>
            <p className="mt-3 text-center text-xs text-slate-500">You will get a prompt on your phone. Enter your M-Pesa PIN to confirm.</p>
          </div>
        )}

        {step === 'waiting' && payment && (
          <div className="mx-auto flex w-full max-w-md flex-col items-center p-8 text-center">
            {payment.status === 'COMPLETED' ? (
              <>
                <CheckCircle2 size={64} className="text-emerald-400" />
                <h3 className="mt-4 text-2xl font-bold text-slate-50">Deposit received</h3>
                <p className="mt-1 text-slate-400">
                  <b className="text-emerald-400">+${fmtNum(payment.amount)}</b> was added to your Real account.
                </p>
                {payment.receipt && <p className="mt-1 font-mono text-xs text-slate-500">M-Pesa receipt {payment.receipt}</p>}
                <button className="mt-6 h-11 w-full rounded-xl bg-sky-600 font-bold text-white hover:bg-sky-500" onClick={() => (setAccountType('REAL'), closeDeposit())}>
                  Trade on my Real account
                </button>
              </>
            ) : payment.status === 'FAILED' || payment.status === 'REJECTED' ? (
              <>
                <XCircle size={64} className="text-red-400" />
                <h3 className="mt-4 text-2xl font-bold text-slate-50">Payment not completed</h3>
                <p className="mt-1 text-slate-400">{payment.message ?? 'The payment did not go through.'}</p>
                <button className="mt-6 h-11 w-full rounded-xl bg-emerald-500 font-bold text-white hover:bg-emerald-600" onClick={() => setStep('form')}>
                  Try again
                </button>
              </>
            ) : payment.status === 'UNCERTAIN' ? (
              <>
                <Clock size={64} className="text-amber-400" />
                <h3 className="mt-4 text-2xl font-bold text-slate-50">We are checking your payment</h3>
                <p className="mt-1 text-slate-400">Our payments team will confirm it shortly. Transaction {payment.reference}.</p>
              </>
            ) : (
              <>
                <div className="relative">
                  <Smartphone size={72} className="text-emerald-400" />
                  <span className="absolute -top-1 -right-1 h-4 w-4 animate-ping rounded-full bg-emerald-400" />
                </div>
                <h3 className="mt-4 text-2xl font-bold text-slate-50">Check your phone</h3>
                <p className="mt-1 text-slate-400">
                  Enter your M-Pesa PIN to pay <b className="text-slate-100">KES {fmtNum(payment.amountKes, 0)}</b> to complete the deposit.
                </p>
                <div className="mt-5 flex items-center gap-2 text-sm text-slate-500">
                  <Loader2 className="animate-spin" size={16} /> Waiting for confirmation…
                </div>
                <p className="mt-4 font-mono text-xs text-slate-600">Transaction {payment.reference}</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
