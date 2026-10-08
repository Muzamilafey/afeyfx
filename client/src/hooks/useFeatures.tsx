import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../services/api';
import { useSocketEvent } from './useSocketEvent';
import type { Features } from '../types';

const NONE: Features = { email: false, googleSignIn: false, githubSignIn: false, ai: false, telegram: false, news: false, forex: false, deposits: false, payouts: false, realTrading: false, realAccount: false };
const Ctx = createContext<{ features: Features; loaded: boolean; reload(): Promise<void> }>({ features: NONE, loaded: false, reload: async () => undefined });

/** Which features are configured on the server. Anything not configured is hidden in the UI. */
export function FeaturesProvider({ children }: { children: ReactNode }) {
  const [features, setFeatures] = useState<Features>(NONE);
  const [loaded, setLoaded] = useState(false);
  const reload = useCallback(async () => {
    const f = await api<Features>('/features').catch(() => null);
    if (f) setFeatures(f);
    setLoaded(true);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  // Admin changes to integrations / payments are broadcast as system events.
  useSocketEvent<{ kind?: string }>('system', (e) => e?.kind === 'features' && void reload());
  return <Ctx.Provider value={{ features, loaded, reload }}>{children}</Ctx.Provider>;
}

export const useFeatures = () => useContext(Ctx);
