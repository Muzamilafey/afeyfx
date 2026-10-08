import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { AuthShell } from '../../components/auth/AuthShell';
import { TwoFactorStep } from '../../components/auth/TwoFactorStep';
import { useAuth } from '../../hooks/useAuth';
import type { SecondFactor, User } from '../../types';

/** Landing page after Google/GitHub. The session arrives as an httpOnly cookie; a 2FA challenge (if any) in the URL fragment. */
export function OAuthCallbackPage() {
  const { completeOAuth } = useAuth();
  const nav = useNavigate();
  const [challenge, setChallenge] = useState<{ token: string; methods: SecondFactor[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const once = useRef(false);
  const go = (u: User | null) => nav(u ? (u.role === 'admin' ? '/admin' : `/${location.search.includes('welcome') ? '?welcome=1' : ''}`) : '/login', { replace: true });

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const h = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', '/auth/callback' + location.search);
    if (h.get('challenge')) {
      setChallenge({ token: h.get('challenge')!, methods: (h.get('methods') ?? 'totp').split(',') as SecondFactor[] });
      return;
    }
    completeOAuth()
      .then((u) => (u ? go(u) : setError('Sign-in could not be completed. Please try again.')))
      .catch(() => setError('Sign-in could not be completed. Please try again.'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (challenge)
    return (
      <AuthShell title="Two-step verification" subtitle="Your social sign-in worked - now confirm your second factor.">
        <TwoFactorStep challengeToken={challenge.token} methods={challenge.methods} onDone={go} onCancel={() => nav('/login')} />
      </AuthShell>
    );
  return (
    <AuthShell title={error ? 'Sign-in failed' : 'Signing you in…'} subtitle={error ?? undefined}>
      {!error ? <LoaderCircle className="mx-auto animate-spin text-sky-400" size={36} /> : <button className="btn-primary w-full" onClick={() => nav('/login')}>Back to sign in</button>}
    </AuthShell>
  );
}
