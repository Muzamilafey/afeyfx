import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useApi } from './useApi';
import { useSocketEvent } from './useSocketEvent';
import type { Mode } from '../types';

export interface SettingsView {
  mode: Mode;
  liveModeActive: boolean;
  tradingEnabled: boolean;
  emergencyShutdown: boolean;
  emergencyReason?: string;
  liveTradingEnabledByEnv: boolean;
  exchange: string;
  risk: Record<string, number | boolean>;
  ai: { enabled: boolean; model: string; minConfidence: number; requireAgreement: boolean };
  integrations: Record<string, boolean>;
}

const Ctx = createContext<{ settings: SettingsView | null; reload(): Promise<void> }>({ settings: null, reload: async () => undefined });

export function TradingStatusProvider({ children }: { children: ReactNode }) {
  const { data, reload } = useApi<SettingsView>('/settings');
  useSocketEvent('system', () => void reload());
  useSocketEvent<{ type: string }>('risk', (e) => {
    if (['STOP_NEW_TRADES', 'RESUME_TRADING', 'EMERGENCY_SHUTDOWN'].includes(e.type)) void reload();
  });
  useEffect(() => {
    const t = setInterval(() => void reload(), 60_000); // safety net in case a socket event is missed
    return () => clearInterval(t);
  }, [reload]);
  return <Ctx.Provider value={{ settings: data, reload }}>{children}</Ctx.Provider>;
}

export const useTradingStatus = () => useContext(Ctx);
