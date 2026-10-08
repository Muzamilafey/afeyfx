import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { AuthShell } from '../../components/auth/AuthShell';
import { api, tryRestoreSession } from '../../services/api';
import { useAuth } from '../../hooks/useAuth';

export function VerifyEmailPage() {
  const { reload, user } = useAuth();
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [msg, setMsg] = useState('');
  const once = useRef(false);

  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const q = new URLSearchParams(location.search);
    api<{ email: string }>('/auth/verify-email', { method: 'POST', body: { uid: q.get('uid'), token: q.get('token') } })
      .then(async (r) => {
        setMsg(r.email);
        setState('ok');
        history.replaceState(null, '', '/verify-email');
        // Refresh the session so the new access token carries the verified flag.
        if (await tryRestoreSession()) await reload();
      })
      .catch((e) => {
        setMsg((e as Error).message);
        setState('error');
      });
  }, [reload]);

  return (
    <AuthShell title="Email verification">
      <div className="card flex flex-col items-center gap-3 py-8 text-center">
        {state === 'working' && <LoaderCircle className="animate-spin text-sky-400" size={36} />}
        {state === 'ok' && <CircleCheck className="text-emerald-400" size={40} />}
        {state === 'error' && <CircleX className="text-red-400" size={40} />}
        <div className="text-lg font-semibold text-slate-50">{state === 'working' ? 'Verifying…' : state === 'ok' ? 'Email verified' : 'Link invalid or expired'}</div>
        <div className="text-sm text-slate-400">{state === 'ok' ? `${msg} is confirmed. Trading is unlocked.` : state === 'error' ? `${msg}. Request a new link from your account page.` : ''}</div>
        <Link to={user ? (user.role === 'admin' ? '/admin' : '/') : '/login'} className="btn-primary mt-2">
          {user ? 'Continue' : 'Sign in'}
        </Link>
      </div>
    </AuthShell>
  );
}
