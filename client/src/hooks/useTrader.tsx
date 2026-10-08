import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../services/api';
import { useSocketEvent } from './useSocketEvent';
import type { DemoAccount, MarketSummary, Position } from '../types';

interface PriceTick {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  timestamp: number;
}

interface TraderCtx {
  account: DemoAccount | null;
  markets: MarketSummary[];
  simulated: boolean;
  positions: Position[];
  prices: Record<string, PriceTick>;
  reloadAccount(): Promise<void>;
  reloadPositions(): Promise<void>;
}

const Ctx = createContext<TraderCtx | null>(null);

/** Shared real-time state for the trader terminal: demo account, markets, prices, open positions. */
export function TraderProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<DemoAccount | null>(null);
  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [simulated, setSimulated] = useState(false);
  const [positions, setPositions] = useState<Position[]>([]);
  const [prices, setPrices] = useState<Record<string, PriceTick>>({});

  const reloadAccount = useCallback(async () => {
    const r = await api<{ account: DemoAccount }>('/account').catch(() => null);
    if (r) setAccount(r.account);
  }, []);
  const reloadPositions = useCallback(async () => {
    const r = await api<{ positions: Position[] }>('/account/positions').catch(() => null);
    if (r) setPositions(r.positions);
  }, []);

  useEffect(() => {
    void reloadAccount();
    void reloadPositions();
    api<{ markets: MarketSummary[]; simulated: boolean }>('/market-data/summary')
      .then((r) => {
        setMarkets(r.markets);
        setSimulated(!!r.simulated);
      })
      .catch(() => undefined);
  }, [reloadAccount, reloadPositions]);

  useSocketEvent<PriceTick>('price', (p) => setPrices((m) => ({ ...m, [p.symbol]: p })));
  // Account events arrive only for this user (server-side routing).
  useSocketEvent<DemoAccount>('portfolio', (p) => setAccount({ ...p, type: 'DEMO' }));
  useSocketEvent('position', () => void reloadPositions());
  useSocketEvent('trade', () => void reloadAccount());

  // Keep the account's unrealized P&L moving with prices between server revaluations.
  useEffect(() => {
    const t = setInterval(() => void reloadAccount(), 15_000);
    return () => clearInterval(t);
  }, [reloadAccount]);

  return <Ctx.Provider value={{ account, markets, simulated, positions, prices, reloadAccount, reloadPositions }}>{children}</Ctx.Provider>;
}

export function useTrader() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTrader outside TraderProvider');
  return c;
}

export const livePnl = (p: Position, price?: number) => (price ? (p.direction === 'LONG' ? (price - p.entryPrice) * p.amount : (p.entryPrice - price) * p.amount) : p.unrealizedPnl);
