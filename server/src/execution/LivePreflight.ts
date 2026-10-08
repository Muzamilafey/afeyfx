import { env, isLiveTradingEnabledByEnv } from '../config/env';
import { exchangeRegistry } from '../exchanges/registry';
import { marketDataCache } from '../marketData/MarketDataCache';
import { getMarketDataService } from '../marketData/MarketDataService';
import { circuitBreaker } from '../risk/CircuitBreaker';
import { RISK_BOUNDS } from '../services/SettingsService';
import { tradingState } from '../services/TradingState';
import { StrategyModel } from '../models/Strategy';
import { errorMessage } from '../utils/logger';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter';

export interface PreflightCheck {
  id: number;
  name: string;
  passed: boolean;
  detail: string;
}

export interface PreflightResult {
  passed: boolean;
  checks: PreflightCheck[];
  exchange: string;
  quoteBalance?: number;
  at: string;
}

/**
 * The 10 mandatory checks before LIVE mode can be enabled. Every check must pass; any error
 * counts as a failure (fail closed). Passing preflight does NOT enable live trading by itself -
 * an authorized admin must still explicitly confirm.
 */
export async function runLivePreflight(exchange = env.DEFAULT_EXCHANGE, adapter: ExchangeAdapter = exchangeRegistry.private(exchange)): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const add = (id: number, name: string, passed: boolean, detail: string) => checks.push({ id, name, passed, detail });
  const safe = async (id: number, name: string, fn: () => Promise<[boolean, string]>) => {
    try {
      const [ok, detail] = await fn();
      add(id, name, ok, detail);
    } catch (err) {
      add(id, name, false, errorMessage(err));
    }
  };

  // 0. Environment kill switch (reported first; without it nothing else matters).
  add(0, 'LIVE_TRADING_ENABLED env flag', isLiveTradingEnabledByEnv(), isLiveTradingEnabledByEnv() ? 'true' : 'LIVE_TRADING_ENABLED is not true - live orders are impossible');

  let quoteBalance: number | undefined;
  await safe(1, 'Exchange API credentials', async () => {
    if (!adapter.hasCredentials) return [false, 'No credentials configured'];
    await adapter.getBalance();
    return [true, 'Authenticated request succeeded'];
  });
  let perms: Awaited<ReturnType<ExchangeAdapter['verifyPermissions']>> | null = null;
  await safe(2, 'Account permissions (trading enabled)', async () => {
    perms = await adapter.verifyPermissions();
    return [perms.verified && perms.canTrade, perms.verified ? `canTrade=${perms.canTrade}${perms.notes.length ? `; ${perms.notes.join('; ')}` : ''}` : perms.notes.join('; ')];
  });
  await safe(3, 'Withdrawals disabled on API key', async () => {
    const p = perms ?? (await adapter.verifyPermissions());
    return [p.verified && p.canWithdraw === false, p.verified ? `canWithdraw=${p.canWithdraw}` : 'Could not verify withdrawal permission'];
  });
  await safe(4, 'Market-data connection', async () => {
    const md = getMarketDataService();
    const ages = md.symbols.map((s) => marketDataCache.dataAgeMs(exchange, s));
    const worst = Math.max(...ages);
    return [md.isRunning && worst <= env.MARKET_DATA_STALE_MS, `running=${md.isRunning}, ${Number.isFinite(worst) ? `worst data age ${Math.round(worst)}ms` : 'no market data received'}`];
  });
  await safe(5, 'Risk limits within safe bounds', async () => {
    const r = tradingState.get().risk;
    const bad = Object.entries(RISK_BOUNDS).filter(([k, [lo, hi]]) => {
      const v = (r as unknown as Record<string, number>)[k];
      return !(v >= lo && v <= hi);
    });
    const okLev = r.maxLeverage <= env.MAX_LEVERAGE || r.maxLeverage <= 1;
    return [bad.length === 0 && okLev, bad.length ? `Out of bounds: ${bad.map(([k]) => k).join(', ')}` : `risk/trade ${r.maxRiskPerTrade}, daily ${r.maxDailyLoss}, weekly ${r.maxWeeklyLoss}, leverage ${r.maxLeverage}`];
  });
  await safe(6, 'Account balance', async () => {
    const bal = await adapter.getBalance();
    const q = bal.find((b) => b.currency === 'USDT' || b.currency === 'USD' || b.currency === 'USDC');
    quoteBalance = q?.free;
    return [!!q && q.free > 0, q ? `${q.currency} free ${q.free}` : 'No quote-currency balance found'];
  });
  await safe(7, 'System time synchronized', async () => {
    const t0 = Date.now();
    const server = await adapter.getServerTime();
    const t1 = Date.now();
    const drift = server - (t0 + t1) / 2;
    circuitBreaker.checkClockDrift(drift, env.MAX_CLOCK_DRIFT_MS);
    return [Math.abs(drift) <= env.MAX_CLOCK_DRIFT_MS, `drift ${Math.round(drift)}ms (max ${env.MAX_CLOCK_DRIFT_MS}ms)`];
  });
  await safe(8, 'Exchange status', async () => {
    const s = await adapter.getStatus();
    return [s.ok, `${s.status}${s.message ? `: ${s.message}` : ''}`];
  });
  await safe(9, 'Emergency stop / circuit breaker clear', async () => {
    const st = tradingState.get();
    const ok = !st.emergencyShutdown && st.tradingEnabled && circuitBreaker.canOpenNewPositions();
    return [ok, ok ? 'clear' : [st.emergencyShutdown ? 'emergency shutdown active' : '', !st.tradingEnabled ? 'trading stopped' : '', ...circuitBreaker.reasons()].filter(Boolean).join('; ')];
  });
  await safe(10, 'At least one strategy approved for LIVE', async () => {
    const n = await StrategyModel.countDocuments({ stage: 'LIVE', enabled: true });
    return [n > 0, `${n} strategies at LIVE stage (human-approved)`];
  });

  return { passed: checks.every((c) => c.passed), checks, exchange, quoteBalance, at: new Date().toISOString() };
}
