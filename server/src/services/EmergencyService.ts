import { circuitBreaker } from '../risk/CircuitBreaker';
import { orderExecutionService } from '../execution/OrderExecutionService';
import { positionManager } from '../execution/PositionManager';
import { tradingEngine } from '../execution/TradingEngine';
import { notificationService } from '../notifications/NotificationService';
import { RiskEventModel } from '../models/RiskEvent';
import { SettingsService } from './SettingsService';
import { tradingState } from './TradingState';
import { LiveModeService } from './LiveModeService';
import { eventBus } from '../utils/eventBus';
import { AppError } from '../utils/errors';

/**
 * Four separate, individually-protected emergency controls (deliberately NOT one button):
 *  1. stopNewTrades      - blocks new entries; exits and stops keep working
 *  2. cancelOpenOrders   - cancels all open orders for the current mode
 *  3. closeAllPositions  - market-closes every open position for the current mode
 *  4. emergencyShutdown  - stops new trades, halts the engine, drops to PAPER (live off), cancels orders
 */
export const EmergencyService = {
  async stopNewTrades(by: string, reason = 'Manual stop') {
    tradingState.update({ tradingEnabled: false });
    circuitBreaker.trip('MANUAL_STOP', `${reason} (by ${by})`);
    await SettingsService.persistFlags({ tradingEnabled: false });
    await RiskEventModel.create({ type: 'STOP_NEW_TRADES', severity: 'WARNING', message: `${reason} (by ${by})` });
    eventBus.publish('risk', { type: 'STOP_NEW_TRADES', by, reason });
    void notificationService.notify('CIRCUIT_BREAKER', 'New trades stopped', `${reason} (by ${by})`);
    return tradingState.get();
  },

  async resumeTrading(by: string) {
    const s = tradingState.get();
    if (s.emergencyShutdown) throw new AppError(409, 'Emergency shutdown active - clear it first', 'EMERGENCY_ACTIVE');
    tradingState.update({ tradingEnabled: true });
    circuitBreaker.reset('MANUAL_STOP');
    await SettingsService.persistFlags({ tradingEnabled: true });
    await RiskEventModel.create({ type: 'RESUME_TRADING', severity: 'INFO', message: `Resumed by ${by}` });
    eventBus.publish('risk', { type: 'RESUME_TRADING', by });
    return tradingState.get();
  },

  async cancelOpenOrders(by: string) {
    const mode = tradingState.get().mode;
    const r = await orderExecutionService.cancelAllOpen(mode);
    await RiskEventModel.create({ type: 'CANCEL_OPEN_ORDERS', severity: 'WARNING', mode, message: `By ${by}: cancelled ${r.cancelled}, errors ${r.errors.length}`, details: r });
    return r;
  },

  async closeAllPositions(by: string) {
    const mode = tradingState.get().mode;
    const r = await positionManager.closeAll(mode, `Emergency close-all by ${by}`);
    await RiskEventModel.create({ type: 'CLOSE_ALL_POSITIONS', severity: 'CRITICAL', mode, message: `By ${by}: closed ${r.closed}, failed ${r.failed.length}`, details: r });
    return r;
  },

  async emergencyShutdown(by: string, reason = 'Emergency shutdown') {
    const priorMode = tradingState.get().mode;
    tradingState.update({ tradingEnabled: false, emergencyShutdown: true, emergencyReason: reason });
    circuitBreaker.trip('EMERGENCY_SHUTDOWN', `${reason} (by ${by})`);
    tradingEngine.stop();
    await SettingsService.persistFlags({ tradingEnabled: false, emergencyShutdown: true, emergencyReason: reason });
    // Cancel resting orders in the mode we were trading, then drop out of LIVE.
    const cancelled = await orderExecutionService.cancelAllOpen(priorMode).catch((e) => ({ cancelled: 0, errors: [String(e)] }));
    if (priorMode === 'LIVE') await LiveModeService.deactivate(`Emergency shutdown by ${by}: ${reason}`);
    await RiskEventModel.create({ type: 'EMERGENCY_SHUTDOWN', severity: 'CRITICAL', mode: priorMode, message: `${reason} (by ${by})`, details: { cancelled } });
    eventBus.publish('risk', { type: 'EMERGENCY_SHUTDOWN', by, reason });
    void notificationService.notify('EMERGENCY_SHUTDOWN', 'EMERGENCY SHUTDOWN', `${reason} (by ${by}). Open positions were NOT closed automatically - use "Close all positions" if required.`);
    return { state: tradingState.get(), cancelled };
  },

  async clearEmergency(by: string) {
    tradingState.update({ emergencyShutdown: false, emergencyReason: undefined });
    circuitBreaker.reset('EMERGENCY_SHUTDOWN');
    await SettingsService.persistFlags({ emergencyShutdown: false, emergencyReason: null });
    await RiskEventModel.create({ type: 'EMERGENCY_CLEARED', severity: 'WARNING', message: `Cleared by ${by}; trading remains stopped until resumed` });
    return tradingState.get();
  },
};
