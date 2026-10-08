import { useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, Clock, Info, XCircle } from 'lucide-react';
import { AccountTabs, STATUS_STYLE } from '../../components/AccountTabs';
import { useApi } from '../../hooks/useApi';
import { useSocketEvent } from '../../hooks/useSocketEvent';
import { fmtNum } from '../../utils/format';
import type { Payment } from '../../types';

const PAGE = 10;
const fmtDate = (d: string) => {
  const x = new Date(d);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(x.getDate())}/${p(x.getMonth() + 1)}/${x.getFullYear()}, ${p(x.getHours())}:${p(x.getMinutes())}:${p(x.getSeconds())}`;
};

function StatusIcon({ s }: { s: string }) {
  if (s === 'COMPLETED') return <CheckCircle2 size={20} className="fill-emerald-500 text-slate-900" />;
  if (s === 'FAILED' || s === 'REJECTED') return <XCircle size={20} className="fill-red-500 text-slate-900" />;
  return <Clock size={20} className="text-amber-400" />;
}

/** Deposits and withdrawals, newest first. */
export function PaymentsPage() {
  const list = useApi<{ payments: Payment[] }>('/payments?limit=200');
  useSocketEvent('payment', () => void list.reload());
  const [page, setPage] = useState(0);
  const all = list.data?.payments ?? [];
  const pages = Math.max(1, Math.ceil(all.length / PAGE));
  const rows = all.slice(page * PAGE, page * PAGE + PAGE);
  return (
    <div className="mx-auto max-w-6xl p-4 md:p-6">
      <AccountTabs />
      <div className="mb-4 flex items-center justify-end gap-3">
        <button className="flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-slate-300 disabled:opacity-40" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          <ChevronLeft size={18} /> Prev
        </button>
        <span className="font-bold text-slate-200">
          {page + 1}/{pages}
        </span>
        <button className="flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-slate-300 disabled:opacity-40" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>
          Next <ChevronRight size={18} />
        </button>
      </div>
      <div className="overflow-x-auto rounded-2xl bg-slate-900 ring-1 ring-slate-800">
        <table className="w-full min-w-[760px] text-left">
          <thead className="text-sm text-slate-400">
            <tr>
              <th className="px-4 py-4 font-medium">Transaction ID</th>
              <th className="px-4 py-4 font-medium">Date and time</th>
              <th className="px-4 py-4 font-medium">Status</th>
              <th className="px-4 py-4 font-medium">Transaction type</th>
              <th className="px-4 py-4 font-medium">Payment system</th>
              <th className="px-4 py-4 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 text-slate-100">
            {rows.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-4 font-mono">{p.reference}</td>
                <td className="px-4 py-4">{fmtDate(p.createdAt)}</td>
                <td className="px-4 py-4">
                  <span className={`flex items-center gap-2 ${STATUS_STYLE[p.status]?.cls}`} title={p.message ?? undefined}>
                    <StatusIcon s={p.status} /> {STATUS_STYLE[p.status]?.label ?? p.status}
                  </span>
                </td>
                <td className="px-4 py-4">{p.type === 'DEPOSIT' ? 'Deposit' : 'Payout'}</td>
                <td className="px-4 py-4">{p.type === 'DEPOSIT' ? 'M-Pesa (Instant Pay)' : 'M-pesa'}</td>
                <td className="px-4 py-4 text-right">
                  <div className={`font-mono font-bold ${p.type === 'DEPOSIT' ? 'text-emerald-400' : 'text-red-400'}`}>
                    {p.type === 'DEPOSIT' ? '+' : '-'}${fmtNum(p.amount)}
                  </div>
                  {p.type === 'PAYOUT' && p.fee > 0 && (
                    <div className="flex items-center justify-end gap-1 text-xs text-slate-400">
                      (${fmtNum(p.fee)} fee <Info size={12} className="text-sky-400" />)
                    </div>
                  )}
                  <div className="text-[11px] text-slate-500">KES {fmtNum(p.amountKes, 0)}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!all.length && <div className="p-8 text-center text-slate-500">{list.loading ? 'Loading…' : 'No payments yet.'}</div>}
      </div>
    </div>
  );
}
