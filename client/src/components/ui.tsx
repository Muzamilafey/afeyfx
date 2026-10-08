import { useState, type ReactNode } from 'react';

export function Card({ title, children, actions, className = '' }: { title?: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="card-title !mb-0">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, valueClass = '' }: { label: string; value: ReactNode; sub?: ReactNode; valueClass?: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
      <div className="text-[11px] font-medium tracking-wide text-slate-500 uppercase">{label}</div>
      <div className={`mt-1 font-mono text-lg font-semibold ${valueClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

const BADGE: Record<string, string> = {
  green: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30',
  red: 'bg-red-500/15 text-red-300 ring-red-500/30',
  amber: 'bg-amber-500/15 text-amber-300 ring-amber-500/30',
  blue: 'bg-sky-500/15 text-sky-300 ring-sky-500/30',
  slate: 'bg-slate-500/15 text-slate-300 ring-slate-500/30',
  purple: 'bg-violet-500/15 text-violet-300 ring-violet-500/30',
};

export function Badge({ children, color = 'slate' }: { children: ReactNode; color?: keyof typeof BADGE }) {
  return <span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${BADGE[color]}`}>{children}</span>;
}

export const signalColor = (s?: string): keyof typeof BADGE => (s === 'LONG' ? 'green' : s === 'SHORT' ? 'red' : s === 'EXIT' ? 'amber' : 'slate');
export const statusColor = (s?: string): keyof typeof BADGE =>
  s === 'ok' || s === 'FILLED' || s === 'EXECUTE' || s === 'COMPLETED' || s === 'OK' ? 'green' : s === 'degraded' || s === 'PARTIALLY_FILLED' || s === 'RUNNING' || s === 'OPEN' ? 'amber' : s === 'disabled' || s === 'CANCELLED' || s === 'DISABLED' ? 'slate' : 'red';

export function Empty({ children = 'No data yet' }: { children?: ReactNode }) {
  return <div className="py-6 text-center text-sm text-slate-500">{children}</div>;
}

export function ErrorText({ error }: { error?: string | null }) {
  if (!error) return null;
  return <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-sm text-red-300">{error}</div>;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose(): void; title: string; children: ReactNode }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-5" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button className="text-slate-400 hover:text-slate-50" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: readonly T[]; value: NoInfer<T>; onChange(t: NoInfer<T>): void }) {
  return (
    <div className="mb-3 flex gap-1 border-b border-slate-800">
      {tabs.map((t) => (
        <button key={t} onClick={() => onChange(t)} className={`-mb-px border-b-2 px-3 py-1.5 text-sm ${value === t ? 'border-sky-500 text-slate-50' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>
          {t}
        </button>
      ))}
    </div>
  );
}

export function useToggle(init = false) {
  const [v, set] = useState(init);
  return [v, () => set((x) => !x), set] as const;
}
