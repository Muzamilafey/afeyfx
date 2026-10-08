import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthShell } from '../../components/auth/AuthShell';
import { SocialButtons } from '../../components/auth/SocialButtons';
import { Field, PasswordField, SubmitButton } from '../../components/auth/fields';
import { TwoFactorStep } from '../../components/auth/TwoFactorStep';
import { ErrorText } from '../../components/ui';
import { useAuth } from '../../hooks/useAuth';
import { takeHashError, useAuthConfig } from '../../hooks/useAuthConfig';
import type { SecondFactor } from '../../types';

export function TraderLoginPage() {
  const { login } = useAuth();
  const cfg = useAuthConfig();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<{ token: string; methods: SecondFactor[] } | null>(null);

  useEffect(() => setError(takeHashError()), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await login(email, password, 'trader');
      if (r.requires2fa) setChallenge({ token: r.challengeToken!, methods: r.methods ?? ['totp'] });
      else nav('/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (challenge)
    return (
      <AuthShell title="Two-step verification" subtitle="One more step to keep your account safe.">
        <TwoFactorStep challengeToken={challenge.token} methods={challenge.methods} onDone={() => nav('/', { replace: true })} onCancel={() => setChallenge(null)} />
      </AuthShell>
    );

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your trading account."
      footer={
        cfg?.signupEnabled !== false && (
          <>
            New to AfeyFX?{' '}
            <Link to="/signup" className="font-semibold text-sky-400 hover:underline">
              Create a free account
            </Link>
          </>
        )
      }
    >
      <SocialButtons config={cfg} />
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email" id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        <PasswordField label="Password" id="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        <ErrorText error={error} />
        <SubmitButton busy={busy}>Sign in</SubmitButton>
      </form>
      <div className="mt-4 text-center text-xs text-slate-500">
        Administrator?{' '}
        <Link to="/admin/login" className="text-slate-400 hover:text-slate-200 hover:underline">
          Admin console sign-in
        </Link>
      </div>
    </AuthShell>
  );
}
