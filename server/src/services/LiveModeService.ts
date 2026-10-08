import { env, isLiveTradingEnabledByEnv } from '../config/env';
import { runLivePreflight, type PreflightResult } from '../execution/LivePreflight';
import { notificationService } from '../notifications/NotificationService';
import { PortfolioModel } from '../models/Portfolio';
import { SettingsService } from './SettingsService';
import { tradingState } from './TradingState';
import { eventBus } from '../utils/eventBus';
import { AppError } from '../utils/errors';

export const LIVE_CONFIRMATION_PHRASE = 'I UNDERSTAND REAL FUNDS ARE AT RISK';

const PREFLIGHT_MAX_AGE_MS = 5 * 60_000;
let lastPreflight: PreflightResult | null = null;

/**
 * LIVE mode lifecycle. Never enabled automatically. Activation requires:
 *  - LIVE_TRADING_ENABLED=true (env)
 *  - a passing preflight run within the last 5 minutes
 *  - an admin with 2FA, re-entering password + TOTP (checked by the route) and typing the confirmation phrase
 */
export const LiveModeService = {
  async preflight() {
    lastPreflight = await runLivePreflight();
    await SettingsService.persistFlags({ lastPreflight });
    return lastPreflight;
  },

  getLastPreflight: () => lastPreflight,

  async activate(userId: string, confirmation: string) {
    if (!isLiveTradingEnabledByEnv()) throw new AppError(403, 'LIVE_TRADING_ENABLED=false on the server. Live mode cannot be activated.', 'LIVE_TRADING_DISABLED');
    if (confirmation !== LIVE_CONFIRMATION_PHRASE) throw new AppError(400, 'Confirmation phrase does not match', 'CONFIRMATION_REQUIRED');
    if (!lastPreflight || !lastPreflight.passed) throw new AppError(412, 'A passing preflight is required before enabling LIVE mode', 'PREFLIGHT_REQUIRED');
    if (Date.now() - new Date(lastPreflight.at).getTime() > PREFLIGHT_MAX_AGE_MS) throw new AppError(412, 'Preflight is older than 5 minutes; run it again', 'PREFLIGHT_STALE');
    const s = tradingState.get();
    if (s.emergencyShutdown) throw new AppError(409, 'Emergency shutdown is active', 'EMERGENCY_ACTIVE');

    await PortfolioModel.updateOne(
      { mode: 'LIVE' },
      { $setOnInsert: { mode: 'LIVE', startingBalance: lastPreflight.quoteBalance ?? 0, balance: lastPreflight.quoteBalance ?? 0, equity: lastPreflight.quoteBalance ?? 0, peakEquity: lastPreflight.quoteBalance ?? 0 }, $set: { lastExchangeBalance: lastPreflight.quoteBalance } },
      { upsert: true },
    );
    tradingState.update({ mode: 'LIVE', liveModeActive: true });
    await SettingsService.persistFlags({ tradingMode: 'LIVE', liveModeActive: true, liveModeActivatedBy: userId, liveModeActivatedAt: new Date() });
    eventBus.publish('system', { kind: 'mode', mode: 'LIVE' });
    void notificationService.notify('LIVE_MODE_ENABLED', 'LIVE trading mode ENABLED', `Activated by user ${userId} on ${env.DEFAULT_EXCHANGE}. Real funds are now at risk.`);
    return tradingState.get();
  },

  async deactivate(reason: string) {
    tradingState.update({ mode: 'PAPER', liveModeActive: false });
    await SettingsService.persistFlags({ tradingMode: 'PAPER', liveModeActive: false });
    eventBus.publish('system', { kind: 'mode', mode: 'PAPER' });
    void notificationService.notify('LIVE_MODE_DISABLED', 'LIVE trading mode disabled', reason);
    return tradingState.get();
  },
};
