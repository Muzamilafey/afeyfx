import { useState } from 'react';
import { Card, ErrorText } from '../components/ui';
import { useAuth } from '../hooks/useAuth';
import { api } from '../services/api';

export function SettingsPage() {
  const { user, logout } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <div className="max-w-xl space-y-4">
      <Card title="Account">
        <div className="text-sm">
          {user?.name} · {user?.email} · <span className="uppercase">{user?.role}</span>
        </div>
      </Card>
      <Card title="Two-factor authentication">
        <ErrorText error={error} />
        {msg && <div className="mb-2 text-sm text-emerald-400">{msg}</div>}
        {user?.twoFactorEnabled ? (
          <div className="space-y-2">
            <div className="text-sm text-emerald-400">2FA is enabled.</div>
            <input className="input" type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <input className="input" placeholder="2FA code" value={code} onChange={(e) => setCode(e.target.value)} />
            <button
              className="btn-ghost"
              onClick={async () => {
                try {
                  await api('/auth/2fa/disable', { method: 'POST', body: { password, code } });
                  setMsg('2FA disabled. Protected admin actions are now unavailable.');
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Disable 2FA
            </button>
          </div>
        ) : setup ? (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">Scan this QR code with an authenticator app, then enter the 6-digit code.</p>
            <img src={setup.qr} alt="2FA QR code" className="h-48 w-48 rounded bg-white p-2" />
            <div className="font-mono text-xs break-all text-slate-400">Manual key: {setup.secret}</div>
            <input className="input" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} placeholder="123456" />
            <button
              className="btn-primary"
              onClick={async () => {
                try {
                  await api('/auth/2fa/confirm', { method: 'POST', body: { code } });
                  setMsg('2FA enabled — please sign in again.');
                  setTimeout(() => void logout(), 1500);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Confirm
            </button>
          </div>
        ) : (
          <div>
            <p className="mb-3 text-sm text-slate-400">2FA is required for admins to use protected actions (live mode, emergency controls, risk limits, exchange keys).</p>
            <button className="btn-primary" onClick={async () => setSetup(await api('/auth/2fa/setup', { method: 'POST' }))}>Set up 2FA</button>
          </div>
        )}
      </Card>
    </div>
  );
}
