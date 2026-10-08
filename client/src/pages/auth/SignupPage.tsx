import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AuthShell } from '../../components/auth/AuthShell';
import { SocialButtons } from '../../components/auth/SocialButtons';
import { Field, PasswordField, PasswordStrength, SubmitButton, passwordChecks } from '../../components/auth/fields';
import { ErrorText } from '../../components/ui';
import { useAuth } from '../../hooks/useAuth';
import { useAuthConfig } from '../../hooks/useAuthConfig';

export function SignupPage() {
  const { register } = useAuth();
  const cfg = useAuthConfig();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accept, setAccept] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strong = passwordChecks(password).every((c) => c.ok);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(email, name, password);
      nav('/?welcome=1', { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (cfg && !cfg.signupEnabled)
    return (
      <AuthShell title="Sign-up is closed" subtitle="Accounts on this platform are created by an administrator." footer={<Link to="/login" className="font-semibold text-sky-400 hover:underline">Back to sign in</Link>}>
        <div />
      </AuthShell>
    );

  return (
    <AuthShell
      title="Create your account"
      subtitle="Start with a $10,000 demo account. No card required."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-sky-400 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <SocialButtons config={cfg} label="Sign up" />
      <form onSubmit={submit} className="space-y-4">
        <Field label="Full name" id="name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required maxLength={100} />
        <Field label="Email" id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        <div>
          <PasswordField label="Password" id="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          {password && <PasswordStrength password={password} />}
        </div>
        <label className="flex items-start gap-2 text-xs text-slate-400">
          <input type="checkbox" className="mt-0.5" checked={accept} onChange={(e) => setAccept(e.target.checked)} />
          <span>I understand trading involves risk of loss, demo results do not predict real results, and nothing here guarantees profit.</span>
        </label>
        <ErrorText error={error} />
        <SubmitButton busy={busy} disabled={!strong || !accept}>
          Create account
        </SubmitButton>
        <p className="text-center text-[11px] text-slate-500">We'll email you a link to verify your address before you can place trades.</p>
      </form>
    </AuthShell>
  );
}
