import type { Mode } from '../types';

/** Always-visible PAPER / LIVE indicator. LIVE is deliberately loud. */
export function ModeBanner({ mode, emergency }: { mode: Mode; emergency?: boolean }) {
  if (emergency) return <div className="bg-red-700 px-4 py-1.5 text-center text-sm font-bold tracking-wide text-white">EMERGENCY SHUTDOWN ACTIVE — no new trades</div>;
  if (mode === 'LIVE') return <div className="animate-pulse bg-red-600 px-4 py-1.5 text-center text-sm font-bold tracking-widest text-white">● LIVE TRADING — REAL FUNDS AT RISK</div>;
  return <div className="bg-sky-900/80 px-4 py-1 text-center text-xs font-semibold tracking-widest text-sky-200">PAPER TRADING — simulated orders, no real funds</div>;
}

export function ModePill({ mode }: { mode: Mode }) {
  return mode === 'LIVE' ? (
    <span className="rounded bg-red-600 px-2 py-0.5 text-xs font-bold text-white">LIVE</span>
  ) : (
    <span className="rounded bg-sky-700 px-2 py-0.5 text-xs font-bold text-white">PAPER</span>
  );
}
