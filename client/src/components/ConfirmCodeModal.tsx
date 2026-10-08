import { useState, type ReactNode } from 'react';
import { KeyRound, Mail } from 'lucide-react';
import { Modal, ErrorText } from './ui';
import { api } from '../services/api';
import { useAuth } from '../hooks/useAuth';

type Factor = 'totp' | 'email';

/**
 * Confirms a money movement with a fresh code. Users with an authenticator use it (or email codes
 * if they enabled them); users without a second factor confirm with a code sent to their email.
 */
export function ConfirmCodeModal({ open, onClose, title, description, context, confirmText = 'Confirm', onConfirm }: { open: boolean; onClose(): void; title: string; description: ReactNode; context: string; confirmText?: string; onConfirm(code: { totp?: string; emailCode?: string }): Promise<void> }) {
  const { user } = useAuth();
  const methods: Factor[] = user?.twoFactorEnabled ? ['totp', ...(user.emailOtpEnabled ? (['email'] as const) : [])] : ['email'];
  const [factor, setFactor] = useState<Factor>(methods[0]);
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    setError(null);
    try {
      await api('/auth/2fa/email/send', { method: 'POST', body: { context } });
      setSent(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(factor === 'totp' ? { totp: code } : { emailCode: code });
      setCode('');
      setSent(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="mb-4 text-sm text-slate-300">{description}</div>
      {methods.length > 1 && (
        <div className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-slate-950 p-1 text-xs">
          {methods.map((m) => (
            <button key={m} type="button" onClick={() => (setFactor(m), setCode(''))} className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 ${factor === m ? 'bg-slate-800 font-semibold text-slate-50' : 'text-slate-400'}`}>
              {m === 'totp' ? <KeyRound size={13} /> : <Mail size={13} />} {m === 'totp' ? 'Authenticator' : 'Email code'}
            </button>
          ))}
        </div>
      )}
      <label className="label">{factor === 'totp' ? 'Authenticator code' : 'Code from email'}</label>
      <div className="flex gap-2">
        <input className="input tracking-[0.4em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" autoComplete="one-time-code" aria-label="Confirmation code" />
        {factor === 'email' && (
          <button type="button" className="btn-ghost whitespace-nowrap" onClick={send}>
            {sent ? 'Resend' : 'Send code'}
          </button>
        )}
      </div>
      {factor === 'email' && sent && <div className="mt-1 text-xs text-emerald-400">Code sent to {user?.email}</div>}
      <ErrorText error={error} />
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn-primary" disabled={busy || code.length !== 6} onClick={submit}>
          {busy ? 'Working…' : confirmText}
        </button>
      </div>
    </Modal>
  );
}
