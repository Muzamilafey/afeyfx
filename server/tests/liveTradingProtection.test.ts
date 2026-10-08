import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import '../src/models';
import { CcxtAdapter } from '../src/exchanges/CcxtAdapter';
import { checkLiveOrder, assertLiveOrderAllowed } from '../src/execution/LiveTradingGuard';
import { tradingState } from '../src/services/TradingState';
import { circuitBreaker } from '../src/risk/CircuitBreaker';
import { exchangeRegistry } from '../src/exchanges/registry';
import { OrderExecutionService } from '../src/execution/OrderExecutionService';
import { LiveModeService, LIVE_CONFIRMATION_PHRASE } from '../src/services/LiveModeService';
import { OrderModel } from '../src/models/Order';
import { LiveTradingDisabledError } from '../src/utils/errors';
import { isLiveTradingEnabledByEnv, reloadEnv, env } from '../src/config/env';
import { fakeCcxtClient } from './helpers/fakeExchange';
import { connectTestDb, clearDb, disconnectTestDb } from './helpers/db';

const ORDER = { symbol: 'BTC/USDT', side: 'buy' as const, type: 'market' as const, amount: 0.01, clientOrderId: 'test-1' };

/** Put every OTHER safeguard into the "allow" position so only the env flag is being tested. */
function armEverythingExceptEnv() {
  tradingState.update({ mode: 'LIVE', liveModeActive: true, tradingEnabled: true, emergencyShutdown: false });
  circuitBreaker.resetAll();
}

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
beforeEach(async () => {
  await clearDb();
  process.env.LIVE_TRADING_ENABLED = 'false';
  tradingState.reset();
  circuitBreaker.resetAll();
  exchangeRegistry.clear();
});
afterEach(() => {
  process.env.LIVE_TRADING_ENABLED = 'false';
  tradingState.reset();
});

describe('defaults', () => {
  it('application defaults to PAPER mode with live trading disabled', () => {
    delete process.env.LIVE_TRADING_ENABLED;
    delete process.env.TRADING_MODE;
    const e = reloadEnv();
    expect(e.TRADING_MODE).toBe('PAPER');
    expect(e.LIVE_TRADING_ENABLED).toBe(false);
    expect(isLiveTradingEnabledByEnv()).toBe(false);
    expect(tradingState.get().mode).toBe('PAPER');
    expect(tradingState.get().liveModeActive).toBe(false);
    process.env.LIVE_TRADING_ENABLED = 'false';
    process.env.TRADING_MODE = 'PAPER';
    reloadEnv();
  });

  it('only the exact value "true" enables the env switch', () => {
    for (const v of ['false', '', '1', 'yes', 'TRUE_', 'on', 'enabled', 'tru']) {
      process.env.LIVE_TRADING_ENABLED = v;
      expect(isLiveTradingEnabledByEnv()).toBe(false);
    }
    process.env.LIVE_TRADING_ENABLED = 'true';
    expect(isLiveTradingEnabledByEnv()).toBe(true);
  });
});

describe('LIVE orders cannot be sent when LIVE_TRADING_ENABLED=false', () => {
  it('guard refuses even when every other safeguard is armed', () => {
    armEverythingExceptEnv();
    const r = checkLiveOrder('OPEN');
    expect(r.allowed).toBe(false);
    expect(r.reasons.join()).toMatch(/LIVE_TRADING_ENABLED/);
    expect(checkLiveOrder('REDUCE').allowed).toBe(false); // not even risk-reducing orders
    expect(() => assertLiveOrderAllowed('OPEN')).toThrow(LiveTradingDisabledError);
  });

  it('exchange adapter refuses before any network call; the exchange client is never invoked', async () => {
    armEverythingExceptEnv();
    const client = fakeCcxtClient();
    const adapter = new CcxtAdapter('binance', { testnet: false, credentials: { apiKey: 'k'.repeat(16), secret: 's'.repeat(16) }, client });
    for (const type of ['market', 'limit', 'stop_loss', 'take_profit'] as const) {
      await expect(adapter.createOrder({ ...ORDER, type, price: 100, stopPrice: 95 })).rejects.toBeInstanceOf(LiveTradingDisabledError);
      await expect(adapter.createOrder({ ...ORDER, type, price: 100, stopPrice: 95, reduceOnly: true })).rejects.toBeInstanceOf(LiveTradingDisabledError);
    }
    expect(client.createOrder).not.toHaveBeenCalled();
  });

  it('OrderExecutionService records a REJECTED order and never reaches the exchange', async () => {
    armEverythingExceptEnv();
    const client = fakeCcxtClient();
    exchangeRegistry.set('binance', new CcxtAdapter('binance', { testnet: false, credentials: { apiKey: 'k'.repeat(16), secret: 's'.repeat(16) }, client }));
    const svc = new OrderExecutionService({ submitTimeoutMs: 1000, maxSubmitAttempts: 3, verifyTimeoutMs: 100, verifyIntervalMs: 10 });
    await expect(svc.submit({ mode: 'LIVE', exchange: 'binance', symbol: 'BTC/USDT', side: 'buy', type: 'market', amount: 0.01, idempotencyKey: 'live-blocked-1', purpose: 'ENTRY' })).rejects.toBeInstanceOf(LiveTradingDisabledError);
    const o = await OrderModel.findOne({ idempotencyKey: 'live-blocked-1' });
    expect(o!.status).toBe('REJECTED');
    expect(o!.rejectReason).toMatch(/LIVE_TRADING_ENABLED/);
    expect(client.createOrder).not.toHaveBeenCalled();
  });

  it('live mode cannot be activated when LIVE_TRADING_ENABLED=false', async () => {
    await expect(LiveModeService.activate('user1', LIVE_CONFIRMATION_PHRASE)).rejects.toThrow(/LIVE_TRADING_ENABLED=false/);
    expect(tradingState.get().mode).toBe('PAPER');
    expect(tradingState.get().liveModeActive).toBe(false);
  });
});

describe('simulated market data', () => {
  it('blocks every live order while the synthetic feed is active', () => {
    process.env.LIVE_TRADING_ENABLED = 'true';
    process.env.MARKET_DATA_SOURCE = 'simulated';
    reloadEnv();
    try {
      armEverythingExceptEnv();
      const r = checkLiveOrder('REDUCE');
      expect(r.allowed).toBe(false);
      expect(r.reasons.join()).toMatch(/Simulated market data/);
    } finally {
      delete process.env.MARKET_DATA_SOURCE;
      reloadEnv();
    }
  });

  it('refuses to start in production with the simulated feed', () => {
    const saved = { ...process.env };
    Object.assign(process.env, { NODE_ENV: 'production', MARKET_DATA_SOURCE: 'simulated', JWT_SECRET: 'x'.repeat(40), JWT_REFRESH_SECRET: 'y'.repeat(40), ENCRYPTION_KEY: 'a'.repeat(64) });
    try {
      expect(() => reloadEnv()).toThrow(/not allowed in production/);
    } finally {
      process.env = saved;
      reloadEnv();
    }
  });
});

describe('other live safeguards (env switch ON)', () => {
  beforeEach(() => {
    process.env.LIVE_TRADING_ENABLED = 'true';
  });

  it('blocks when mode is PAPER or live mode was not activated by a user', () => {
    tradingState.update({ mode: 'PAPER', liveModeActive: false });
    expect(checkLiveOrder('OPEN').allowed).toBe(false);
    tradingState.update({ mode: 'LIVE', liveModeActive: false });
    expect(checkLiveOrder('OPEN').reasons.join()).toMatch(/not been activated/);
  });

  it('blocks new positions on emergency shutdown, stopped trading or open circuit breaker, but allows risk-reducing exits', () => {
    armEverythingExceptEnv();
    expect(checkLiveOrder('OPEN').allowed).toBe(true); // positive control
    circuitBreaker.trip('STALE_MARKET_DATA', 'test');
    expect(checkLiveOrder('OPEN').allowed).toBe(false);
    expect(checkLiveOrder('REDUCE').allowed).toBe(true);
    circuitBreaker.resetAll();
    tradingState.update({ emergencyShutdown: true });
    expect(checkLiveOrder('OPEN').allowed).toBe(false);
    tradingState.update({ emergencyShutdown: false, tradingEnabled: false });
    expect(checkLiveOrder('OPEN').allowed).toBe(false);
  });

  it('activation requires the exact confirmation phrase and a passing, fresh preflight', async () => {
    await expect(LiveModeService.activate('u', 'yes')).rejects.toThrow(/Confirmation phrase/);
    await expect(LiveModeService.activate('u', LIVE_CONFIRMATION_PHRASE)).rejects.toThrow(/preflight/i);
    expect(tradingState.get().liveModeActive).toBe(false);
  });

  it('when fully authorized, the adapter does submit (positive control proves the guard is the only blocker)', async () => {
    armEverythingExceptEnv();
    const client = fakeCcxtClient();
    const adapter = new CcxtAdapter('binance', { testnet: true, credentials: { apiKey: 'k'.repeat(16), secret: 's'.repeat(16) }, client });
    await adapter.createOrder(ORDER);
    expect(client.createOrder).toHaveBeenCalledTimes(1);
    expect(env.NODE_ENV).toBe('test');
  });
});
