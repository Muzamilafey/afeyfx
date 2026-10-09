import { useState } from 'react';
import { Modal, ErrorText } from './ui';
import { useToast } from './Toaster';
import { useAuth, isAdmin } from '../hooks/useAuth';
import { api } from '../services/api';

/**
 * Lets an ADMIN mark their own email as verified without an email round-trip (e.g. before SMTP is
 * configured). The server asks for the account password as proof of ownership.
 */
export function VerifySelfButton({ className = 'font-semibold underline' }: { className?: string }) {
  const { user, reload } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!user || user.emailVerified || !isAdmin(user)) return null;
  const needsPassword = user.passwordSet !== false;
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/users/me/verify-email', { method: 'POST', body: needsPassword ? { password } : {} });
      await reload();
      setOpen(false);
      setPassword('');
      toast('success', 'Email verified', user.email);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button className={className} onClick={() => setOpen(true)}>
        Verify now (admin)
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Verify your email">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="text-sm text-slate-300">
            As an administrator you can confirm <b>{user.email}</b> yourself, without a verification email.
            {needsPassword ? ' Enter your password to confirm.' : ''}
          </p>
          {needsPassword && <input className="input" type="password" autoComplete="current-password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Password" autoFocus />}
          <ErrorText error={error} />
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn-primary" disabled={busy || (needsPassword && !password)}>
              {busy ? 'Verifying…' : 'Verify my email'}
            </button>
          </div>
        </form>
      </Modal>
    </>
  );
}
