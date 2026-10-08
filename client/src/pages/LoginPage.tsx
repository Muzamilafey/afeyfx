import { useState, type FormEvent } from 'react';
import { useAuth } from '../hooks/useAuth';
import { ErrorText } from '../components/ui';

export function LoginPage() {
  const { login, verify2fa, register } = useAuth();
  const [step, setStep] = useState<'login' | '2fa' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-2xl font-bold">
          Afey<span className="text-emerald-400">FX</span>
          <div className="mt-1 text-xs font-normal text-slate-500">AI-assisted algorithmic trading</div>
        </div>
        <div className="card">
          {step === 'login' && (
            <form
              onSubmit={run(async () => {
                const r = await login(email, password);
                if (r.requires2fa) {
                  setChallenge(r.challengeToken!);
                  setStep('2fa');
                }
              })}
              className="space-y-3"
            >
              <div>
                <label className="label" htmlFor="email">Email</label>
                <input id="email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
              </div>
              <div>
                <label className="label" htmlFor="password">Password</label>
                <input id="password" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
              </div>
              <ErrorText error={error} />
              <button className="btn-primary w-full" disabled={busy}>Sign in</button>
              <button type="button" className="w-full text-xs text-slate-500 hover:text-slate-300" onClick={() => setStep('register')}>First run? Create the admin account</button>
            </form>
          )}
          {step === '2fa' && (
            <form onSubmit={run(() => verify2fa(challenge, code))} className="space-y-3">
              <div className="text-sm text-slate-300">Enter the 6-digit code from your authenticator app.</div>
              <input className="input text-center text-lg tracking-[0.5em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus autoComplete="one-time-code" aria-label="2FA code" />
              <ErrorText error={error} />
              <button className="btn-primary w-full" disabled={busy || code.length !== 6}>Verify</button>
            </form>
          )}
          {step === 'register' && (
            <form onSubmit={run(() => register(email, name, password))} className="space-y-3">
              <div className="text-xs text-slate-400">Only available while no accounts exist. The first account becomes the administrator; later accounts are created by an admin.</div>
              <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
              <input className="input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              <input className="input" type="password" placeholder="Password (12+ chars, upper/lower/digit)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
              <ErrorText error={error} />
              <button className="btn-primary w-full" disabled={busy}>Create admin</button>
              <button type="button" className="w-full text-xs text-slate-500" onClick={() => setStep('login')}>Back to sign in</button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
