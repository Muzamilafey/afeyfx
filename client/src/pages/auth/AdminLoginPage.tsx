import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { AuthShell } from '../../components/auth/AuthShell';
import { Field, PasswordField, SubmitButton } from '../../components/auth/fields';
import { TwoFactorStep } from '../../components/auth/TwoFactorStep';
import { ErrorText } from '../../components/ui';
import { useAuth } from '../../hooks/useAuth';
import { takeHashError } from '../../hooks/useAuthConfig';
import type { SecondFactor } from '../../types';

/** Separate sign-in for the admin console. Only admin accounts are accepted (enforced server-side). */
export function AdminLoginPage() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [bootstrap, setBootstrap] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<{ token: string; methods: SecondFactor[] } | null>(null);

  useEffect(() => setError(takeHashError()), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (bootstrap) {
        const u = await register(email, name, password);
        if (u.role !== 'admin') throw new Error('An administrator already exists. Ask them to grant you admin access.');
        nav('/admin', { replace: true });
        return;
      }
      const r = await login(email, password, 'admin');
      if (r.requires2fa) setChallenge({ token: r.challengeToken!, methods: r.methods ?? ['totp'] });
      else nav('/admin', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (challenge)
    return (
      <AuthShell variant="admin" title="Verify it's you" subtitle="Admin sessions always require your second factor when enabled.">
        <TwoFactorStep challengeToken={challenge.token} methods={challenge.methods} onDone={() => nav('/admin', { replace: true })} onCancel={() => setChallenge(null)} />
      </AuthShell>
    );

  return (
    <AuthShell
      variant="admin"
      title={bootstrap ? 'Create the first administrator' : 'Admin console'}
      subtitle={
        <span className="inline-flex items-center gap-1.5">
          <ShieldCheck size={14} className="text-emerald-400" /> Restricted area · admin accounts only
        </span>
      }
      footer={
        <Link to="/login" className="text-slate-400 hover:text-slate-200 hover:underline">
          ← Trader sign-in
        </Link>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {bootstrap && <Field label="Name" id="name" value={name} onChange={(e) => setName(e.target.value)} required />}
        <Field label="Admin email" id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        <PasswordField label="Password" id="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={bootstrap ? 'new-password' : 'current-password'} required />
        <ErrorText error={error} />
        <SubmitButton busy={busy}>{bootstrap ? 'Create administrator' : 'Sign in to console'}</SubmitButton>
      </form>
      <button className="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-300" onClick={() => setBootstrap((b) => !b)}>
        {bootstrap ? 'I already have an admin account' : 'First run? Create the administrator account'}
      </button>
    </AuthShell>
  );
}
