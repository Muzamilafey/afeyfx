import mongoose from 'mongoose';
import { env, isLiveTradingEnabledByEnv } from '../config/env';
import { getMarketDataService } from '../marketData/MarketDataService';
import { circuitBreaker } from '../risk/CircuitBreaker';
import { tradingEngine } from '../execution/TradingEngine';
import { getClaudeService } from '../ai/ClaudeService';
import { tradingState } from './TradingState';
import { RiskEngine } from '../risk/RiskEngine';

type Status = 'ok' | 'degraded' | 'down' | 'disabled';

let socketClients = 0;
export const setSocketClientCount = (n: number) => {
  socketClients = n;
};

/** Aggregated component health used by /api/system/health and the admin dashboard. */
export async function systemHealth() {
  const dbState = mongoose.connection.readyState; // 1 = connected
  let dbPingMs: number | null = null;
  if (dbState === 1) {
    const t = Date.now();
    try {
      await mongoose.connection.db!.admin().ping();
      dbPingMs = Date.now() - t;
    } catch {
      dbPingMs = null;
    }
  }
  const md = getMarketDataService();
  const mdHealth = md.isRunning ? md.checkHealth() : null;
  // Risk engine self-test: a known-bad input must be rejected.
  let riskOk = false;
  try {
    const r = new RiskEngine(tradingState.get().risk).evaluate({
      mode: 'PAPER', symbol: 'TEST', direction: 'LONG', entryPrice: 100, stopLoss: 101, feeRate: 0, expectedSlippagePct: 0,
      account: { equity: 1, available: 1, dayStartEquity: 1, weekStartEquity: 1 }, openPositions: [],
      market: { bid: 99, ask: 101, dataAgeMs: 0, maxDataAgeMs: 1 }, circuitBreaker: { open: false, reasons: [] },
    });
    riskOk = r.approved === false;
  } catch {
    riskOk = false;
  }
  if (!riskOk) circuitBreaker.trip('RISK_ENGINE_UNAVAILABLE', 'Risk engine self-test failed');
  else circuitBreaker.recover('RISK_ENGINE_UNAVAILABLE');

  const components: Record<string, { status: Status; detail?: unknown }> = {
    database: { status: dbState === 1 && dbPingMs !== null ? 'ok' : 'down', detail: { readyState: dbState, pingMs: dbPingMs } },
    marketData: {
      status: !md.isRunning ? 'disabled' : mdHealth && mdHealth.worstDataAgeMs <= env.MARKET_DATA_STALE_MS ? 'ok' : 'degraded',
      detail: { exchange: md.exchange, symbols: md.symbols, ...mdHealth, lastError: md.lastError },
    },
    exchangeWebSocket: { status: md.exchange !== 'binance' ? 'disabled' : md.wsConnected ? 'ok' : md.isRunning ? 'degraded' : 'disabled' },
    tradingEngine: { status: tradingEngine.isRunning ? 'ok' : 'disabled', detail: { lastScanAt: tradingEngine.lastScanAt || null, lastError: tradingEngine.lastError } },
    riskEngine: { status: riskOk ? 'ok' : 'down' },
    ai: { status: getClaudeService().available ? 'ok' : 'disabled', detail: { model: tradingState.get().ai.model } },
    websocket: { status: 'ok', detail: { clients: socketClients } },
  };
  const s = tradingState.get();
  const critical = ['database', 'riskEngine'];
  const overall: Status = critical.some((c) => components[c].status === 'down') ? 'down' : Object.values(components).some((c) => c.status === 'degraded' || c.status === 'down') ? 'degraded' : 'ok';
  return {
    status: overall,
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    trading: {
      mode: s.mode,
      liveTradingEnabledByEnv: isLiveTradingEnabledByEnv(),
      liveModeActive: s.liveModeActive,
      tradingEnabled: s.tradingEnabled,
      emergencyShutdown: s.emergencyShutdown,
      circuitBreaker: circuitBreaker.status(),
    },
    components,
    memory: { rssMb: Math.round(process.memoryUsage().rss / 1e6) },
  };
}
