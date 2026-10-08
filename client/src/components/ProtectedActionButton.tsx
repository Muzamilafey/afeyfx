import { useState, type ReactNode } from 'react';
import { KeyRound, Mail } from 'lucide-react';
import { Modal, ErrorText } from './ui';
import { api } from '../services/api';
import { useAuth } from '../hooks/useAuth';
import type { SecondFactor } from '../types';

interface Props {
  label: ReactNode;
  title: string;
  description: ReactNode;
  endpoint: string;
  method?: string;
  className?: string;
  extraFields?: { name: string; label: string; type?: string; placeholder?: string }[];
  body?: Record<string, unknown>;
  confirmText?: string;
  onDone?(result: unknown): void;
  disabled?: boolean;
}

/**
 * A button for protected admin actions: opens a confirmation dialog that requires a fresh second
 * factor - an authenticator code or a single-use emailed code - plus optional extra fields.
 * Each emergency control uses its own instance; they are never combined into one button.
 */
export function ProtectedActionButton({ label, title, description, endpoint, method = 'POST', className = 'btn-danger', extraFields = [], body = {}, confirmText = 'Confirm', onDone, disabled }: Props) {
  const { user } = useAuth();
  const methods: SecondFactor[] = [...(user?.twoFactorEnabled ? (['totp'] as const) : []), ...(user?.emailOtpEnabled ? (['email'] as const) : [])];
  const [open, setOpen] = useState(false);
  const [factor, setFactor] = useState<SecondFactor>(methods[0] ?? 'totp');
  const [code, setCode] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const sendEmail = async () => {
    setError(null);
    try {
      await api('/auth/2fa/email/send', { method: 'POST', body: { context: title.slice(0, 80) } });
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api(endpoint, { method, body: { ...body, ...fields, ...(factor === 'email' ? { emailCode: code } : { totp: code }) } });
      setResult('Done');
      onDone?.(r);
      setTimeout(() => {
        setOpen(false);
        setResult(null);
        setSent(false);
      }, 700);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setCode('');
    }
  };

  return (
    <>
      <button className={className} onClick={() => setOpen(true)} disabled={disabled}>
        {label}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={title}>
        <div className="mb-4 text-sm text-slate-300">{description}</div>
        {extraFields.map((f) => (
          <div key={f.name} className="mb-3">
            <label className="label">{f.label}</label>
            <input className="input" type={f.type ?? 'text'} placeholder={f.placeholder} value={fields[f.name] ?? ''} onChange={(e) => setFields({ ...fields, [f.name]: e.target.value })} autoComplete="off" />
          </div>
        ))}
        {!methods.length ? (
          <div className="rounded-md border border-amber-900 bg-amber-950/40 p-2 text-sm text-amber-300">Enable an authenticator app or email codes in your account security settings to use protected actions.</div>
        ) : (
          <div className="mb-4 space-y-2">
            {methods.length > 1 && (
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-slate-950 p-1 text-xs">
                {methods.map((m) => (
                  <button key={m} type="button" onClick={() => (setFactor(m), setCode(''))} className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 ${factor === m ? 'bg-slate-800 font-semibold text-slate-50' : 'text-slate-400'}`}>
                    {m === 'totp' ? <KeyRound size={13} /> : <Mail size={13} />} {m === 'totp' ? 'Authenticator' : 'Email code'}
                  </button>
                ))}
              </div>
            )}
            <label className="label">{factor === 'totp' ? '2FA code' : 'Code from email'}</label>
            <div className="flex gap-2">
              <input className="input tracking-[0.4em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" autoComplete="one-time-code" />
              {factor === 'email' && (
                <button type="button" className="btn-ghost whitespace-nowrap" onClick={sendEmail}>
                  {sent ? 'Resend' : 'Send code'}
                </button>
              )}
            </div>
          </div>
        )}
        <ErrorText error={error} />
        {result && <div className="text-sm text-emerald-400">{result}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn-ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button className={className} disabled={busy || code.length !== 6} onClick={submit}>
            {busy ? 'Working…' : confirmText}
          </button>
        </div>
      </Modal>
    </>
  );
}
