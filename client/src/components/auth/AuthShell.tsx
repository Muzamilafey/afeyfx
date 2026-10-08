import type { ReactNode } from 'react';
import { Activity, Bot, ShieldCheck, Zap } from 'lucide-react';
import { Logo } from '../BrandIcons';
import { ThemeToggle } from '../ThemeToggle';

const FEATURES = [
  { icon: Activity, title: 'Real-time markets', text: 'Streaming prices, order books and candles.' },
  { icon: Zap, title: 'Practice risk-free', text: 'Every trader gets a personal demo account.' },
  { icon: Bot, title: 'AI-assisted analysis', text: 'Structured insights. The risk engine always decides.' },
  { icon: ShieldCheck, title: 'Security first', text: '2FA, email verification and audited actions.' },
];

/** Split-screen layout for authentication pages. `variant="admin"` uses a restrained console look. */
export function AuthShell({ title, subtitle, children, variant = 'trader', footer }: { title: string; subtitle?: ReactNode; children: ReactNode; variant?: 'trader' | 'admin'; footer?: ReactNode }) {
  const admin = variant === 'admin';
  return (
    <div className="flex min-h-screen bg-slate-950">
      <aside className={`relative hidden w-[46%] overflow-hidden lg:flex lg:flex-col lg:justify-between ${admin ? 'bg-[#0b1220]' : 'bg-gradient-to-br from-[#062a4a] via-[#0b1830] to-[#04111f]'} p-10 text-white`}>
        <div className="pointer-events-none absolute inset-0 opacity-40">
          <svg className="h-full w-full" viewBox="0 0 600 600" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="g" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={admin ? '#64748b' : '#38bdf8'} stopOpacity="0.5" />
                <stop offset="100%" stopColor={admin ? '#64748b' : '#38bdf8'} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path d="M0 420 L60 380 L110 400 L170 330 L220 350 L280 270 L330 300 L390 220 L440 250 L500 170 L560 190 L600 140 L600 600 L0 600 Z" fill="url(#g)" />
            <path d="M0 420 L60 380 L110 400 L170 330 L220 350 L280 270 L330 300 L390 220 L440 250 L500 170 L560 190 L600 140" fill="none" stroke={admin ? '#94a3b8' : '#38bdf8'} strokeWidth="3" />
          </svg>
        </div>
        <div className="relative">
          <span className="inline-flex items-center gap-2 text-xl font-bold">
            <Logo withText={false} size={34} />
            Afey<span className="text-sky-300">FX</span>
            {admin && <span className="ml-2 rounded-md bg-white/10 px-2 py-0.5 text-xs font-semibold tracking-widest">ADMIN CONSOLE</span>}
          </span>
        </div>
        <div className="relative space-y-6">
          <h2 className="max-w-md text-3xl leading-tight font-bold">{admin ? 'Operate the trading engine with every safeguard in place.' : 'Trade smarter. Practice first. Stay in control.'}</h2>
          {admin ? (
            <ul className="space-y-2 text-sm text-white/80">
              <li>• Admin accounts only — every action is audited</li>
              <li>• Protected actions require a fresh 2FA code</li>
              <li>• LIVE trading stays off until explicitly enabled</li>
            </ul>
          ) : (
            <div className="grid max-w-lg grid-cols-2 gap-4">
              {FEATURES.map((f) => (
                <div key={f.title} className="rounded-xl border border-white/10 bg-white/5 p-4 backdrop-blur">
                  <f.icon size={20} className="text-sky-300" />
                  <div className="mt-2 text-sm font-semibold">{f.title}</div>
                  <div className="mt-1 text-xs text-white/70">{f.text}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <p className="relative text-[11px] text-white/50">Trading involves substantial risk of loss. Nothing on this platform guarantees profit.</p>
      </aside>
      <main className="flex flex-1 flex-col">
        <div className="flex items-center justify-between p-4 lg:justify-end">
          <span className="lg:hidden">
            <Logo />
          </span>
          <ThemeToggle />
        </div>
        <div className="flex flex-1 items-center justify-center px-4 pb-10">
          <div className="w-full max-w-[400px]">
            <h1 className="text-2xl font-bold text-slate-50">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
            <div className="mt-6">{children}</div>
            {footer && <div className="mt-6 text-center text-sm text-slate-400">{footer}</div>}
          </div>
        </div>
      </main>
    </div>
  );
}
