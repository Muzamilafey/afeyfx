import { env, isLiveTradingEnabledByEnv } from '../../config/env';
import { BrokerConnectionModel, type BrokerConnectionDoc } from '../../models/BrokerConnection';
import { BrokerCapabilityModel, BrokerEventModel, BrokerSyncLogModel, MarketInstrumentModel, Mt5CommandModel, StrategyAccountAssignmentModel } from '../../models/BrokerRecords';
import { OrderModel } from '../../models/Order';
import { PositionModel } from '../../models/Position';
import { TradeModel } from '../../models/Trade';
import { AuthService } from '../../services/AuthService';
import { AppError } from '../../utils/errors';
import { errorMessage } from '../../utils/logger';
import { PROVIDERS } from '../core/capabilities';
import { BrokerError } from '../core/types';
import { mt5Bridge } from '../mt5/Mt5Bridge';
import { brokerAuth } from './BrokerAuthenticationService';
import { brokerAccounts, brokerHealth, brokerMarketData, publishBroker } from './BrokerDataServices';
import { brokerReconciliation } from './BrokerReconciliationService';
import { brokerRegistry, logBrokerEvent, recordConnectionError } from './BrokerRegistry';

export const LIVE_CONFIRM_PHRASE = 'ENABLE LIVE TRADING';

const maskId = (id?: string | null) => (!id ? '' : id.length <= 4 ? `••${id.slice(-2)}` : `${'•'.repeat(Math.min(6, id.length - 4))}${id.slice(-4)}`);

/** User-owned broker connections: lifecycle, views (no secrets, masked ids) and controls. */
export class BrokerConnectionService {
  async owned(userId: string, id: string) {
    const c = await BrokerConnectionModel.findOne({ _id: id, user: userId });
    if (!c) throw new AppError(404, 'Broker connection not found');
    return c;
  }

  view(c: BrokerConnectionDoc) {
    const p = PROVIDERS[c.provider as 'deriv' | 'mt5'];
    return {
      id: c._id.toString(),
      provider: c.provider,
      providerName: p.name,
      label: c.label,
      accountId: maskId(c.accountId),
      environment: c.environment,
      currency: c.currency ?? null,
      status: c.status,
      tradingEnabled: c.tradingEnabled,
      liveEnabled: c.liveEnabled,
      isDefault: c.isDefault,
      balance: c.balance ?? null,
      equity: c.equity ?? null,
      margin: c.margin ?? null,
      freeMargin: c.freeMargin ?? null,
      marginLevel: c.marginLevel ?? null,
      leverage: c.leverage ?? null,
      lastSyncAt: c.lastSyncAt ?? null,
      lastHeartbeatAt: c.lastHeartbeatAt ?? null,
      latencyMs: c.latencyMs ?? null,
      lastError: c.lastError ?? null,
      lastErrorAt: c.lastErrorAt ?? null,
      recoveredAt: c.recoveredAt ?? null,
      breaker: c.breaker?.tripped ? { tripped: true, reason: c.breaker.reason, at: c.breaker.at } : { tripped: false },
      riskLimits: c.riskLimits,
      tokenExpiresAt: c.tokenExpiresAt ?? null,
      authMethod: c.tokenType ?? null,
      terminal: c.provider === 'mt5' ? { terminalId: c.terminalId, server: (c.terminalInfo as { server?: string } | undefined)?.server, company: (c.terminalInfo as { company?: string } | undefined)?.company, eaVersion: (c.terminalInfo as { eaVersion?: string } | undefined)?.eaVersion } : undefined,
      features: Object.entries(p.capabilities).filter(([, v]) => v.status === 'implemented').map(([k]) => k),
      liveRequirements: c.environment === 'real' ? { envSwitch: isLiveTradingEnabledByEnv(), adminAllows: env.BROKER_USER_LIVE_ALLOWED, confirmed: c.liveEnabled } : undefined,
      createdAt: c.createdAt,
    };
  }

  async list(userId: string) {
    const list = await BrokerConnectionModel.find({ user: userId, status: { $ne: 'REVOKED' } }).sort({ isDefault: -1, createdAt: 1 });
    const out = [];
    for (const c of list) out.push({ ...this.view(c), openPositions: await PositionModel.countDocuments({ connection: c._id, status: 'OPEN' }), openOrders: await OrderModel.countDocuments({ connection: c._id, status: { $in: ['OPEN', 'PENDING', 'SUBMITTED', 'UNKNOWN'] } }) });
    return out;
  }

  /** New MT5 connection: returns the terminal id and the secret ONCE. */
  async createMt5(userId: string, environment: 'demo' | 'real', label?: string) {
    if (!env.MT5_BRIDGE_ENABLED) throw new AppError(403, 'The MT5 bridge is disabled', 'MT5_DISABLED');
    const creds = brokerAuth.issueTerminalCredentials();
    const c = await BrokerConnectionModel.create({ user: userId, provider: 'mt5', environment, label: label || `MT5 ${environment === 'demo' ? 'Demo' : 'Real'}`, status: 'PENDING', tokenType: 'terminal', terminalId: creds.terminalId, terminalSecretEnc: creds.terminalSecretEnc });
    await logBrokerEvent(c, 'CREATED', 'MT5 terminal credentials issued');
    return { connection: this.view(c), terminalId: creds.terminalId, terminalSecret: creds.terminalSecret, bridgeUrl: `${(env.API_PUBLIC_URL || env.APP_URL || env.CLIENT_ORIGIN.split(',')[0]).replace(/\/+$/, '')}/api/bridge/mt5` };
  }

  async rotateTerminalSecret(userId: string, id: string) {
    const c = await this.owned(userId, id);
    if (c.provider !== 'mt5') throw new AppError(400, 'Only MT5 connections have terminal secrets');
    const creds = brokerAuth.issueTerminalCredentials();
    c.terminalSecretEnc = creds.terminalSecretEnc;
    c.status = 'PENDING';
    await c.save();
    mt5Bridge.reset(c._id.toString());
    await logBrokerEvent(c, 'REAUTHORIZED', 'Terminal secret rotated; the old secret no longer works', undefined, 'warn');
    return { terminalId: c.terminalId, terminalSecret: creds.terminalSecret };
  }

  /** Test connection: validate access with the broker and record the capabilities verified. */
  async test(userId: string, id: string) {
    const c = await this.owned(userId, id);
    const t0 = Date.now();
    try {
      await brokerRegistry.drop(c._id.toString());
      const adapter = await brokerRegistry.get(c);
      const a = await adapter.validateAccess();
      if (a.environment !== c.environment) throw new BrokerError('environment_mismatch', `Broker reports a ${a.environment} account`);
      await brokerAccounts.sync(c, a);
      const verifiedOn = c.environment;
      for (const cap of ['connect', 'accountInfo']) await BrokerCapabilityModel.updateOne({ provider: c.provider, capability: cap, verifiedOn }, { $set: { ok: true, connection: c._id, at: new Date(), message: `Verified on ${c.provider} ${verifiedOn} account` } }, { upsert: true });
      await BrokerSyncLogModel.create({ connection: c._id, user: c.user, kind: 'test', ok: true, durationMs: Date.now() - t0, message: `Connected to ${a.accountId ? maskId(a.accountId) : 'account'}` });
      await logBrokerEvent(c, 'TEST_OK', `Connection test passed (${Date.now() - t0} ms)`);
      return { ok: true, latencyMs: Date.now() - t0, account: { currency: a.currency, balance: a.balance, equity: a.equity, environment: a.environment } };
    } catch (err) {
      await recordConnectionError(c, err);
      await BrokerSyncLogModel.create({ connection: c._id, user: c.user, kind: 'test', ok: false, durationMs: Date.now() - t0, message: errorMessage(err).slice(0, 300) });
      await logBrokerEvent(c, 'TEST_FAILED', errorMessage(err), undefined, 'error');
      return { ok: false, latencyMs: Date.now() - t0, error: errorMessage(err), kind: err instanceof BrokerError ? err.kind : 'error' };
    }
  }

  /** Synchronize account, instruments and positions with the broker. */
  async sync(userId: string, id: string) {
    const c = await this.owned(userId, id);
    const account = await brokerAccounts.sync(c);
    const instruments = await brokerMarketData.syncInstruments(c).catch((err) => (logBrokerEvent(c, 'SYNC_WARN', `Instruments: ${errorMessage(err)}`, undefined, 'warn'), 0));
    const reconcile = await brokerReconciliation.run((await BrokerConnectionModel.findById(c._id))!);
    publishBroker(userId, id, 'synced', { at: Date.now() });
    return { account, instruments, reconcile };
  }

  async health(userId: string, id: string) {
    const c = await this.owned(userId, id);
    const h = await brokerHealth.check(c);
    return { ...h, status: c.status, lastSyncAt: c.lastSyncAt, lastHeartbeatAt: c.lastHeartbeatAt, breaker: c.breaker };
  }

  /**
   * Disconnect: stop trading, close the live session, delete stored credentials (MT5: the secret
   * stops working at once). Deriv tokens are deleted locally; revoke the app in Deriv settings too.
   */
  async disconnect(userId: string, id: string) {
    const c = await this.owned(userId, id);
    await brokerRegistry.drop(c._id.toString());
    brokerMarketData.clear(c._id.toString());
    mt5Bridge.reset(c._id.toString());
    await Mt5CommandModel.updateMany({ connection: c._id, status: 'QUEUED' }, { $set: { status: 'EXPIRED' } });
    const open = await PositionModel.countDocuments({ connection: c._id, status: 'OPEN' });
    c.set({ tradingEnabled: false, liveEnabled: false, isDefault: false, status: 'REVOKED', accessTokenEnc: undefined, refreshTokenEnc: undefined, terminalSecretEnc: undefined, disconnectedAt: new Date() });
    await c.save();
    await StrategyAccountAssignmentModel.updateMany({ connection: c._id }, { $set: { enabled: false } });
    await logBrokerEvent(c, 'DISCONNECTED_BY_USER', `Disconnected; credentials deleted${open ? `. ${open} position(s) remain open AT THE BROKER and are no longer managed` : ''}`, undefined, 'warn');
    return { ok: true, openPositionsAtBroker: open, note: c.provider === 'deriv' ? 'Also revoke AfeyFX in your Deriv account settings (API / authorized apps).' : 'Remove the EA from your terminal.' };
  }

  async setTrading(userId: string, id: string, enabled: boolean) {
    const c = await this.owned(userId, id);
    if (enabled) {
      if (c.status !== 'CONNECTED') throw new AppError(409, 'Connect and test the account first', 'NOT_CONNECTED');
      if (c.breaker?.tripped) throw new AppError(409, `Account is halted: ${c.breaker.reason}`, 'BREAKER');
    }
    c.tradingEnabled = enabled;
    if (!enabled) c.liveEnabled = false;
    await c.save();
    await logBrokerEvent(c, enabled ? 'TRADING_ENABLED' : 'TRADING_DISABLED', enabled ? 'Trading enabled' : 'Trading disabled', undefined, enabled ? 'info' : 'warn');
    return this.view(c);
  }

  /**
   * Enable LIVE (real-money) trading on a REAL account. Requires: the server switch, the admin
   * permission, a verified real account, password, a fresh second factor (checked by the route)
   * and the typed confirmation phrase. Never automatic.
   */
  async enableLive(userId: string, id: string, input: { password?: string; confirm: string }) {
    const c = await this.owned(userId, id);
    if (c.environment !== 'real') throw new AppError(400, 'Demo accounts trade without live enablement');
    if (!isLiveTradingEnabledByEnv()) throw new AppError(403, 'Live trading is disabled on this server (LIVE_TRADING_ENABLED)', 'LIVE_DISABLED');
    if (!env.BROKER_USER_LIVE_ALLOWED) throw new AppError(403, 'Live trading on personal broker accounts is not enabled by the administrator', 'LIVE_NOT_ALLOWED');
    if (input.confirm !== LIVE_CONFIRM_PHRASE) throw new AppError(400, `Type "${LIVE_CONFIRM_PHRASE}" to confirm`, 'CONFIRMATION_REQUIRED');
    if (input.password !== undefined && !(await AuthService.verifyPassword(userId, input.password))) throw new AppError(401, 'Incorrect password', 'INVALID_CREDENTIALS');
    const t = await this.test(userId, id);
    if (!t.ok || t.account?.environment !== 'real') throw new AppError(409, `The real account could not be verified: ${t.error ?? 'environment mismatch'}`, 'VERIFY_FAILED');
    const fresh = await this.owned(userId, id);
    fresh.liveEnabled = true;
    fresh.liveEnabledAt = new Date();
    fresh.tradingEnabled = true;
    await fresh.save();
    await logBrokerEvent(fresh, 'LIVE_ENABLED', 'LIVE trading enabled on this real account', undefined, 'warn');
    return this.view(fresh);
  }

  async setDefault(userId: string, id: string) {
    const c = await this.owned(userId, id);
    await BrokerConnectionModel.updateMany({ user: userId }, { $set: { isDefault: false } });
    c.isDefault = true;
    await c.save();
    return this.view(c);
  }

  async updateLimits(userId: string, id: string, limits: Record<string, number>) {
    const c = await this.owned(userId, id);
    const bounds: Record<string, [number, number]> = { maxRiskPerTrade: [0.0005, 0.02], maxDailyLoss: [0.002, 0.1], maxWeeklyLoss: [0.005, 0.2], maxLeverage: [0.1, 30], maxOpenPositions: [1, 50], maxExposurePct: [0.01, 30], maxSpreadPct: [0.00001, 0.05], maxSlippagePct: [0.00001, 0.05], maxQuoteAgeMs: [1000, 120_000], maxConsecutiveFailures: [1, 10], balanceChangeTolerancePct: [0.001, 0.2] };
    for (const [k, v] of Object.entries(limits)) {
      const b = bounds[k];
      if (!b || !Number.isFinite(v) || v < b[0] || v > b[1]) throw new AppError(400, `${k} must be between ${b?.[0]} and ${b?.[1]}`, 'VALIDATION_ERROR');
      c.set(`riskLimits.${k}`, v);
    }
    if ((c.riskLimits?.maxWeeklyLoss ?? 0) < (c.riskLimits?.maxDailyLoss ?? 0)) throw new AppError(400, 'Weekly loss limit must be ≥ the daily limit', 'VALIDATION_ERROR');
    await c.save();
    await logBrokerEvent(c, 'LIMITS_UPDATED', 'Risk limits updated', limits);
    return this.view(c);
  }

  /** Reset a tripped breaker after review (refused while unverified orders remain). */
  async resetBreaker(userId: string, id: string) {
    const c = await this.owned(userId, id);
    const unknown = await OrderModel.countDocuments({ connection: c._id, status: 'UNKNOWN' });
    if (unknown) throw new AppError(409, `${unknown} order(s) are still unverified; synchronize first`, 'UNVERIFIED_ORDERS');
    c.breaker = { tripped: false, reason: undefined, at: undefined } as never;
    c.consecutiveFailures = 0;
    await c.save();
    await logBrokerEvent(c, 'BREAKER_RESET', 'Circuit breaker reset by the user');
    return this.view(c);
  }

  async logs(userId: string, id: string, limit = 100) {
    const c = await this.owned(userId, id);
    const [events, syncs] = await Promise.all([BrokerEventModel.find({ connection: c._id }).sort({ at: -1 }).limit(Math.min(limit, 500)).lean(), BrokerSyncLogModel.find({ connection: c._id }).sort({ at: -1 }).limit(50).lean()]);
    return { events, syncs };
  }

  async instruments(userId: string, id: string) {
    const c = await this.owned(userId, id);
    return MarketInstrumentModel.find({ connection: c._id }).sort({ category: 1, brokerSymbol: 1 }).limit(3000).lean();
  }

  async positions(userId: string, id: string, status: 'OPEN' | 'CLOSED') {
    const c = await this.owned(userId, id);
    return PositionModel.find({ connection: c._id, user: userId, status }).sort({ openedAt: -1 }).limit(200).lean();
  }

  async orders(userId: string, id: string) {
    const c = await this.owned(userId, id);
    return OrderModel.find({ connection: c._id, user: userId }).sort({ createdAt: -1 }).limit(200).select('-exchangeResponses').lean();
  }

  async trades(userId: string, id: string) {
    const c = await this.owned(userId, id);
    return TradeModel.find({ connection: c._id, user: userId }).sort({ closedAt: -1 }).limit(200).lean();
  }

  async account(userId: string, id: string) {
    const c = await this.owned(userId, id);
    const a = await brokerAccounts.sync(c);
    return { ...a, accountId: maskId(a?.accountId), raw: undefined };
  }

  // ------------------------------------------------------------ strategy assignments

  async assignments(userId: string) {
    return StrategyAccountAssignmentModel.find({ user: userId }).lean();
  }

  async assign(userId: string, input: { connectionId: string; strategyKey: string; symbolMap: Record<string, string>; product: 'cfd' | 'multiplier' | 'rise_fall'; multiplier?: number; enabled: boolean }) {
    const c = await this.owned(userId, input.connectionId);
    if (c.provider === 'deriv' && input.product === 'cfd') throw new AppError(400, 'Deriv accounts trade Multipliers or Rise/Fall, not CFDs');
    if (c.provider === 'mt5' && input.product !== 'cfd') throw new AppError(400, 'MT5 accounts trade CFDs');
    if (input.product === 'multiplier' && !input.multiplier) throw new AppError(400, 'Choose a multiplier');
    const doc = await StrategyAccountAssignmentModel.findOneAndUpdate({ connection: c._id, strategyKey: input.strategyKey }, { $set: { user: userId, symbolMap: input.symbolMap, product: input.product, multiplier: input.multiplier, enabled: input.enabled } }, { upsert: true, returnDocument: 'after' });
    await logBrokerEvent(c, 'ASSIGNMENT', `${input.enabled ? 'Routing' : 'Not routing'} strategy ${input.strategyKey} to this account`, { symbolMap: input.symbolMap });
    return doc;
  }

  async unassign(userId: string, assignmentId: string) {
    await StrategyAccountAssignmentModel.deleteOne({ _id: assignmentId, user: userId });
  }
}

export const brokerConnections = new BrokerConnectionService();
