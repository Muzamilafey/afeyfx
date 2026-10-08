import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, tokenStore, tryRestoreSession } from '../services/api';
import { closeSocket } from '../websocket/socket';
import type { SecondFactor, User } from '../types';

export interface FirstFactorResult {
  requires2fa: boolean;
  challengeToken?: string;
  methods?: SecondFactor[];
}

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login(email: string, password: string, portal?: 'trader' | 'admin'): Promise<FirstFactorResult>;
  verify2fa(challengeToken: string, code: string, method: SecondFactor): Promise<User>;
  sendLoginCode(challengeToken: string): Promise<void>;
  register(email: string, name: string, password: string): Promise<User>;
  /** Called after an OAuth redirect: the refresh cookie was set by the server. */
  completeOAuth(): Promise<User | null>;
  logout(): Promise<void>;
  reload(): Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      setUser((await api<{ user: User }>('/auth/me')).user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      // OAuth callback pages complete their own session hand-off.
      if (!location.pathname.startsWith('/auth/callback') && (await tryRestoreSession())) await reload();
      setLoading(false);
    })();
  }, [reload]);

  const session = (r: { accessToken: string; user: User }) => {
    tokenStore.set(r.accessToken);
    setUser(r.user);
    return r.user;
  };

  const value: AuthCtx = {
    user,
    loading,
    async login(email, password, portal = 'trader') {
      const r = await api<{ accessToken?: string; user?: User; requires2fa?: boolean; challengeToken?: string; methods?: SecondFactor[] }>('/auth/login', { method: 'POST', body: { email, password, portal } });
      if (r.requires2fa) return { requires2fa: true, challengeToken: r.challengeToken, methods: r.methods };
      session(r as { accessToken: string; user: User });
      return { requires2fa: false };
    },
    async verify2fa(challengeToken, code, method) {
      return session(await api('/auth/2fa/verify', { method: 'POST', body: { challengeToken, code, method } }));
    },
    async sendLoginCode(challengeToken) {
      await api('/auth/2fa/email/send-login', { method: 'POST', body: { challengeToken } });
    },
    async register(email, name, password) {
      return session(await api('/auth/register', { method: 'POST', body: { email, name, password } }));
    },
    async completeOAuth() {
      if (!(await tryRestoreSession())) return null;
      const me = (await api<{ user: User }>('/auth/me')).user;
      setUser(me);
      return me;
    },
    async logout() {
      await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
      tokenStore.set(null);
      closeSocket();
      setUser(null);
    },
    reload,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside AuthProvider');
  return c;
}

export const canTrade = (u: User | null) => u?.role === 'trader' || u?.role === 'admin';
export const isAdmin = (u: User | null) => u?.role === 'admin';
export const hasSecondFactor = (u: User | null) => !!u?.twoFactorEnabled || !!u?.emailOtpEnabled;
