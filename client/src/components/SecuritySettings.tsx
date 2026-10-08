import { useState, type ReactNode } from 'react';
import { CircleCheck, KeyRound, Lock, Mail, ShieldAlert } from 'lucide-react';
import { Badge, Card, ErrorText } from './ui';
import { GitHubIcon, GoogleIcon } from './BrandIcons';
import { PasswordField, PasswordStrength, passwordChecks } from './auth/fields';
import { useAuth } from '../hooks/useAuth';
import { api } from '../services/api';

function Row({ icon, title, desc, status, children }: { icon: ReactNode; title: string; desc: string; status?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-b border-slate-800 py-4 last:border-0 sm:flex-row sm:items-start">
      <div className="flex flex-1 gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-800 text-sky-400">{icon}</div>
        <div>
          <div className="flex items-center gap-2 font-semibold text-slate-100">
            {title} {status}
          </div>
          <div className="text-sm text-slate-400">{desc}</div>
        </div>
      </div>
      <div className="sm:w-72">{children}</div>
    </div>
  );
}

/** Account security: email verification, authenticator 2FA, email-code 2FA, password, linked sign-ins. */
export function SecuritySettings() {
  const { user, reload, logout } = useAuth();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totpSetup, setTotpSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [emailStep, setEmailStep] = useState<'idle' | 'sent'>('idle');
  const [emailCode, setEmailCode] = useState('');
  const [pw, setPw] = useState({ current: '', next: '' });
  const [disable, setDisable] = useState({ password: '', code: '' });

  const run = (fn: () => Promise<unknown>, ok?: string) => async () => {
    setError(null);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg(ok);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!user) return null;

  return (
    <Card title="Security">
      {msg && <div className="mb-2 rounded-md border border-emerald-900 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-400">{msg}</div>}
      <ErrorText error={error} />

      <Row icon={<Mail size={18} />} title="Email address" desc={user.email} status={user.emailVerified ? <Badge color="green">verified</Badge> : <Badge color="amber">not verified</Badge>}>
        {!user.emailVerified && (
          <button className="btn-primary w-full" onClick={run(() => api('/auth/resend-verification', { method: 'POST' }), 'Verification email sent - check your inbox.')}>
            Send verification email
          </button>
        )}
      </Row>

      <Row icon={<KeyRound size={18} />} title="Authenticator app" desc="Time-based codes from Google Authenticator, 1Password, Authy…" status={user.twoFactorEnabled ? <Badge color="green">on</Badge> : <Badge color="slate">off</Badge>}>
        {user.twoFactorEnabled ? (
          <div className="space-y-2">
            {user.passwordSet && <input className="input" type="password" placeholder="Password" value={disable.password} onChange={(e) => setDisable({ ...disable, password: e.target.value })} />}
            <input className="input" placeholder="Authenticator code" inputMode="numeric" maxLength={6} value={disable.code} onChange={(e) => setDisable({ ...disable, code: e.target.value.replace(/\D/g, '') })} />
            <button className="btn-ghost w-full" onClick={run(async () => { await api('/auth/2fa/disable', { method: 'POST', body: { password: disable.password || undefined, code: disable.code } }); await logout(); })}>
              Disable authenticator
            </button>
          </div>
        ) : totpSetup ? (
          <div className="space-y-2">
            <img src={totpSetup.qr} alt="Authenticator QR code" className="mx-auto h-40 w-40 rounded-lg bg-white p-2" />
            <div className="font-mono text-[11px] break-all text-slate-500" data-secret>
              {totpSetup.secret}
            </div>
            <input className="input text-center tracking-[0.4em]" inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <button className="btn-primary w-full" disabled={code.length !== 6} onClick={run(async () => { await api('/auth/2fa/confirm', { method: 'POST', body: { code } }); setTimeout(() => void logout(), 1200); }, 'Authenticator enabled - please sign in again.')}>
              Confirm and enable
            </button>
          </div>
        ) : (
          <button className="btn-primary w-full" onClick={run(async () => setTotpSetup(await api('/auth/2fa/setup', { method: 'POST' })))}>
            Set up authenticator
          </button>
        )}
      </Row>

      <Row icon={<ShieldAlert size={18} />} title="Email codes" desc="Receive a one-time code by email to sign in and confirm protected actions." status={user.emailOtpEnabled ? <Badge color="green">on</Badge> : <Badge color="slate">off</Badge>}>
        {!user.emailVerified ? (
          <div className="text-xs text-slate-500">Verify your email address first.</div>
        ) : user.emailOtpEnabled ? (
          <div className="space-y-2">
            {emailStep === 'idle' ? (
              <button className="btn-ghost w-full" onClick={run(async () => { await api('/auth/2fa/email/send', { method: 'POST', body: { context: 'disable email codes' } }); setEmailStep('sent'); }, 'Code sent to your email.')}>
                Disable email codes
              </button>
            ) : (
              <>
                <input className="input text-center tracking-[0.4em]" inputMode="numeric" maxLength={6} placeholder="Email code" value={emailCode} onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))} />
                <button className="btn-ghost w-full" disabled={emailCode.length !== 6} onClick={run(async () => { await api('/auth/2fa/email/disable', { method: 'POST', body: { emailCode } }); await logout(); })}>
                  Confirm disable
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            {emailStep === 'idle' ? (
              <button className="btn-primary w-full" onClick={run(async () => { await api('/auth/2fa/email/send', { method: 'POST', body: { context: 'enable email codes' } }); setEmailStep('sent'); }, 'We sent a 6-digit code to your email.')}>
                Enable email codes
              </button>
            ) : (
              <>
                <input className="input text-center tracking-[0.4em]" inputMode="numeric" maxLength={6} placeholder="Code from email" value={emailCode} onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, ''))} />
                <button className="btn-primary w-full" disabled={emailCode.length !== 6} onClick={run(async () => { await api('/auth/2fa/email/enable', { method: 'POST', body: { code: emailCode } }); setTimeout(() => void logout(), 1200); }, 'Email codes enabled - please sign in again.')}>
                  Confirm and enable
                </button>
              </>
            )}
          </div>
        )}
      </Row>

      <Row icon={<Lock size={18} />} title={user.passwordSet ? 'Password' : 'Set a password'} desc={user.passwordSet ? 'Change the password used for email sign-in.' : 'You sign in with Google/GitHub. A password lets you sign in with email too (and is required to enable LIVE trading).'}>
        <div className="space-y-2">
          {user.passwordSet && <PasswordField label="Current password" id="pw-current" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />}
          <PasswordField label="New password" id="pw-new" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
          {pw.next && <PasswordStrength password={pw.next} />}
          <button className="btn-primary w-full" disabled={!passwordChecks(pw.next).every((c) => c.ok)} onClick={run(async () => { await api('/auth/password', { method: 'POST', body: { currentPassword: pw.current || undefined, newPassword: pw.next } }); setPw({ current: '', next: '' }); await reload(); }, 'Password saved.')}>
            Save password
          </button>
        </div>
      </Row>

      <Row icon={<CircleCheck size={18} />} title="Sign-in methods" desc="Social accounts are linked automatically when their verified email matches yours.">
        <div className="space-y-1.5 text-sm">
          <div className="flex items-center justify-between"><span className="flex items-center gap-2"><GoogleIcon size={15} /> Google</span>{user.googleId ? <Badge color="green">connected</Badge> : <Badge color="slate">not connected</Badge>}</div>
          <div className="flex items-center justify-between"><span className="flex items-center gap-2"><GitHubIcon size={15} /> GitHub</span>{user.githubId ? <Badge color="green">connected</Badge> : <Badge color="slate">not connected</Badge>}</div>
          <div className="flex items-center justify-between"><span className="flex items-center gap-2"><Mail size={15} /> Email & password</span>{user.passwordSet ? <Badge color="green">enabled</Badge> : <Badge color="slate">not set</Badge>}</div>
        </div>
      </Row>
    </Card>
  );
}
