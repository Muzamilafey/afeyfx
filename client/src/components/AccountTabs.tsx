import { NavLink } from 'react-router-dom';
import { useFeatures } from '../hooks/useFeatures';

/** Account section tabs (Withdrawal / Payments / Trades / My account / Market), shown on account pages. */
export function AccountTabs() {
  const { features } = useFeatures();
  const tabs = [
    ...(features.payouts ? [{ to: '/withdrawal', label: 'Withdrawal' }] : []),
    ...(features.deposits || features.payouts ? [{ to: '/payments', label: 'Payments' }] : []),
    { to: '/history', label: 'Trades' },
    { to: '/account', label: 'My account' },
    { to: '/markets', label: 'Market' },
  ];
  return (
    <nav className="mb-5 flex gap-1 overflow-x-auto rounded-xl bg-slate-900 p-1.5 ring-1 ring-slate-800" aria-label="Account sections">
      {tabs.map((t) => (
        <NavLink key={t.to} to={t.to} className={({ isActive }) => `rounded-lg px-4 py-2 text-sm font-bold whitespace-nowrap transition ${isActive ? 'bg-sky-600 text-white shadow' : 'text-slate-300 hover:text-slate-50'}`}>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

export const STATUS_STYLE: Record<string, { cls: string; label: string }> = {
  COMPLETED: { cls: 'text-emerald-400', label: 'Successful' },
  PENDING: { cls: 'text-amber-400', label: 'Pending' },
  PROCESSING: { cls: 'text-sky-400', label: 'Processing' },
  UNCERTAIN: { cls: 'text-amber-400', label: 'Under review' },
  FAILED: { cls: 'text-red-400', label: 'Failed' },
  REJECTED: { cls: 'text-red-400', label: 'Declined' },
  CANCELLED: { cls: 'text-slate-400', label: 'Cancelled' },
};
