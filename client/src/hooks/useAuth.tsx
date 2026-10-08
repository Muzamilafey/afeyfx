import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, tokenStore, tryRestoreSession } from '../services/api';
import { closeSocket } from '../websocket/socket';
import type { User } from '../types';

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login(email: string, password: string): Promise<{ requires2fa: boolean; challengeToken?: string }>;
  verify2fa(challengeToken: string, code: string): Promise<void>;
  register(email: string, name: string, password: string): Promise<void>;
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
      if (await tryRestoreSession()) await reload();
      setLoading(false);
    })();
  }, [reload]);

  const session = (r: { accessToken: string; user: User }) => {
    tokenStore.set(r.accessToken);
    setUser(r.user);
  };

  const value: AuthCtx = {
    user,
    loading,
    async login(email, password) {
      const r = await api<{ accessToken?: string; user?: User; requires2fa?: boolean; challengeToken?: string }>('/auth/login', { method: 'POST', body: { email, password } });
      if (r.requires2fa) return { requires2fa: true, challengeToken: r.challengeToken };
      session(r as { accessToken: string; user: User });
      return { requires2fa: false };
    },
    async verify2fa(challengeToken, code) {
      session(await api('/auth/2fa/verify', { method: 'POST', body: { challengeToken, code } }));
    },
    async register(email, name, password) {
      session(await api('/auth/register', { method: 'POST', body: { email, name, password } }));
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
