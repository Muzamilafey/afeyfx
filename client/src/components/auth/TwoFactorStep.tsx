import { useEffect, useState, type FormEvent } from 'react';
import { KeyRound, Mail } from 'lucide-react';
import { ErrorText } from '../ui';
import { SubmitButton } from './fields';
import { useAuth } from '../../hooks/useAuth';
import type { SecondFactor, User } from '../../types';

/** Second step of sign-in: authenticator code or emailed code (whichever the account has enabled). */
export function TwoFactorStep({ challengeToken, methods, onDone, onCancel }: { challengeToken: string; methods: SecondFactor[]; onDone(u: User): void; onCancel(): void }) {
  const { verify2fa, sendLoginCode } = useAuth();
  const [method, setMethod] = useState<SecondFactor>(methods.includes('totp') ? 'totp' : 'email');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const send = async () => {
    setError(null);
    try {
      await sendLoginCode(challengeToken);
      setInfo('We emailed you a 6-digit code. It expires in 10 minutes.');
      setCooldown(30);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  useEffect(() => {
    if (method === 'email' && !methods.includes('totp')) void send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onDone(await verify2fa(challengeToken, code, method));
    } catch (err) {
      setError((err as Error).message);
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {methods.length > 1 && (
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-900 p-1">
          {methods.map((m) => (
            <button key={m} type="button" onClick={() => (setMethod(m), setCode(''), setError(null))} className={`flex items-center justify-center gap-2 rounded-md py-2 text-sm ${method === m ? 'bg-slate-800 font-semibold text-slate-50' : 'text-slate-400'}`}>
              {m === 'totp' ? <KeyRound size={15} /> : <Mail size={15} />} {m === 'totp' ? 'Authenticator' : 'Email code'}
            </button>
          ))}
        </div>
      )}
      <p className="text-sm text-slate-400">{method === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Enter the 6-digit code we send to your verified email.'}</p>
      {method === 'email' && (
        <button type="button" className="btn-ghost w-full" onClick={send} disabled={cooldown > 0}>
          <Mail size={15} /> {cooldown > 0 ? `Resend in ${cooldown}s` : info ? 'Resend code' : 'Email me a code'}
        </button>
      )}
      {info && method === 'email' && <div className="text-xs text-emerald-400">{info}</div>}
      <input className="input h-12 text-center text-xl tracking-[0.6em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus autoComplete="one-time-code" aria-label="2FA code" placeholder="••••••" />
      <ErrorText error={error} />
      <SubmitButton busy={busy} disabled={code.length !== 6}>
        Verify and sign in
      </SubmitButton>
      <button type="button" className="w-full text-xs text-slate-500 hover:text-slate-300" onClick={onCancel}>
        Use a different account
      </button>
    </form>
  );
}
