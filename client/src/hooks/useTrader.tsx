import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../services/api';
import { useSocketEvent } from './useSocketEvent';
import { useFeatures } from './useFeatures';
import { useAuth } from './useAuth';
import { useToast } from '../components/Toaster';
import type { AccountType, MarketSummary, Payment, PaymentPublicConfig, Position, TraderAccount } from '../types';

interface PriceTick {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  timestamp: number;
}

interface TraderCtx {
  accountType: AccountType;
  setAccountType(t: AccountType): void;
  account: TraderAccount | null;
  accounts: Partial<Record<AccountType, TraderAccount>>;
  markets: MarketSummary[];
  simulated: boolean;
  positions: Position[];
  prices: Record<string, PriceTick>;
  payConfig: PaymentPublicConfig | null;
  reloadAccount(): Promise<void>;
  reloadPositions(): Promise<void>;
  /** Deposit dialog (rendered by the layout). */
  depositOpen: boolean;
  openDeposit(): void;
  closeDeposit(): void;
  /** Latest payment update pushed by the server (deposit/withdrawal status). */
  lastPayment: Payment | null;
}

const Ctx = createContext<TraderCtx | null>(null);
const KEY = 'afx-account';
const readType = (): AccountType => {
  try {
    return localStorage.getItem(KEY) === 'REAL' ? 'REAL' : 'DEMO';
  } catch {
    return 'DEMO';
  }
};

/** Shared real-time state for the trader terminal: accounts, markets, prices, open positions, payments. */
export function TraderProvider({ children }: { children: ReactNode }) {
  const { features } = useFeatures();
  const toast = useToast();
  const [accountType, setType] = useState<AccountType>(readType);
  const [accounts, setAccounts] = useState<Partial<Record<AccountType, TraderAccount>>>({});
  const [markets, setMarkets] = useState<MarketSummary[]>([]);
  const [simulated, setSimulated] = useState(false);
  const [positions, setPositions] = useState<Position[]>([]);
  const [prices, setPrices] = useState<Record<string, PriceTick>>({});
  const [payConfig, setPayConfig] = useState<PaymentPublicConfig | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);
  const [lastPayment, setLastPayment] = useState<Payment | null>(null);
  // The REAL account is only offered when the admin has set up payments or real trading.
  const { user } = useAuth();
  const userId = user?._id;
  const effectiveType: AccountType = features.realAccount ? accountType : 'DEMO';

  const setAccountType = useCallback((t: AccountType) => {
    setType(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private mode */
    }
  }, []);

  const reloadAccount = useCallback(async () => {
    const r = await api<{ accounts: Record<AccountType, TraderAccount> }>('/account').catch(() => null);
    if (r?.accounts) setAccounts(r.accounts);
  }, []);
  const reloadPositions = useCallback(async () => {
    const r = await api<{ positions: Position[] }>(`/account/positions?account=${effectiveType}`).catch(() => null);
    if (r) setPositions(r.positions);
  }, [effectiveType]);

  useEffect(() => {
    void reloadAccount();
    api<{ markets: MarketSummary[]; simulated: boolean }>('/market-data/summary')
      .then((r) => {
        setMarkets(r.markets);
        setSimulated(!!r.simulated);
      })
      .catch(() => undefined);
  }, [reloadAccount]);
  useEffect(() => {
    void reloadPositions();
  }, [reloadPositions]);
  useEffect(() => {
    if (!features.realAccount) return;
    api<PaymentPublicConfig>('/payments/config').then(setPayConfig, () => undefined);
  }, [features.realAccount]);

  useSocketEvent<PriceTick>('price', (p) => setPrices((m) => ({ ...m, [p.symbol]: p })));
  // Account events arrive only for this user (server-side routing).
  useSocketEvent<TraderAccount & { mode: string; owner?: string | null }>('portfolio', (p) => {
    // Admins also receive the platform's system book (owner null): never show it as the trader's own balance.
    if (!p.owner || p.owner !== userId) return;
    const type: AccountType = p.mode === 'REAL' ? 'REAL' : 'DEMO';
    setAccounts((a) => ({ ...a, [type]: { ...p, type } }));
  });
  useSocketEvent('position', () => void reloadPositions());
  useSocketEvent('trade', () => void reloadAccount());
  useSocketEvent<Payment>('payment', (p) => {
    setLastPayment(p);
    void reloadAccount();
    const what = p.type === 'DEPOSIT' ? 'Deposit' : 'Withdrawal';
    if (p.status === 'COMPLETED') toast('success', `${what} completed`, `${p.type === 'DEPOSIT' ? '+' : '-'}$${p.amount.toFixed(2)} · M-Pesa`);
    else if (p.status === 'FAILED' || p.status === 'REJECTED') toast('error', `${what} ${p.status.toLowerCase()}`, p.message ?? undefined);
  });

  // Refresh market stats and the account periodically (prices themselves stream).
  useEffect(() => {
    const t = setInterval(() => {
      void reloadAccount();
      api<{ markets: MarketSummary[] }>('/market-data/summary').then((r) => setMarkets(r.markets), () => undefined);
    }, 15_000);
    return () => clearInterval(t);
  }, [reloadAccount]);

  return (
    <Ctx.Provider
      value={{
        accountType: effectiveType,
        setAccountType,
        account: accounts[effectiveType] ?? null,
        accounts,
        markets,
        simulated,
        positions,
        prices,
        payConfig,
        reloadAccount,
        reloadPositions,
        depositOpen,
        openDeposit: () => setDepositOpen(true),
        closeDeposit: () => setDepositOpen(false),
        lastPayment,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useTrader() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useTrader outside TraderProvider');
  return c;
}

/** Open P&L in USD (pairs quoted in another currency are converted with the entry rate). */
export const livePnl = (p: Position, price?: number) => (price ? (p.direction === 'LONG' ? (price - p.entryPrice) * p.amount : (p.entryPrice - price) * p.amount) * (p.quoteRate ?? 1) : p.unrealizedPnl);

/** Decimals to show for a symbol's price. */
export function pricePrecision(markets: MarketSummary[], symbol: string, price?: number) {
  const m = markets.find((x) => x.symbol === symbol);
  if (m?.pricePrecision !== undefined) return m.pricePrecision;
  const p = price ?? m?.price;
  if (!p) return 2;
  return p >= 1000 ? 2 : p >= 10 ? 3 : p >= 1 ? 4 : 5;
}
