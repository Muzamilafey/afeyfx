import { env, isLiveTradingEnabledByEnv } from '../config/env';
import { BrokerConfigModel, type BrokerConfigDoc } from '../models/BrokerConfig';
import { PositionModel } from '../models/Position';
import { SystemEventModel } from '../models/SystemEvent';
import { instrumentOf, type InstrumentCategory } from '../marketData/instruments';
import { notificationService } from '../notifications/NotificationService';
import { tradingState } from '../services/TradingState';
import { AppError, LiveTradingDisabledError } from '../utils/errors';
import { decrypt, encrypt, mask } from '../utils/crypto';
import { errorMessage, logger } from '../utils/logger';
import { DerivAdapter } from './DerivAdapter';
import { OandaBrokerAdapter } from './OandaBrokerAdapter';
import type { BrokerAdapter, BrokerId, BrokerTestResult } from './types';

export type Route = 'internal' | BrokerId;
const CATEGORIES: InstrumentCategory[] = ['crypto', 'forex', 'metals'];

/**
 * Routing of REAL-account orders to external brokers, and the guard every broker order passes.
 *
 * An order reaches an external broker only if ALL of these hold:
 *  1. LIVE_TRADING_ENABLED=true in the server environment (the same hard kill switch as live
 *     exchange trading; it cannot be set from the UI)
 *  2. an admin routed the asset class to that broker (protected action) after a passing connection test
 *  3. market data is real (never the simulated feed)
 *  4. for new positions: no emergency shutdown and new trades not stopped
 * Otherwise the order is rejected - it never silently falls back to an internal fill.
 */
export class BrokerService {
  private adapters = new Map<BrokerId, BrokerAdapter>();
  private override = new Map<BrokerId, BrokerAdapter>();

  /** Test hook: replace an adapter. */
  setAdapter(id: BrokerId, a: BrokerAdapter | null) {
    if (a) this.override.set(id, a);
    else this.override.delete(id);
  }

  async config(): Promise<BrokerConfigDoc> {
    return (await BrokerConfigModel.findOneAndUpdate({ key: 'brokers' }, { $setOnInsert: { key: 'brokers' } }, { upsert: true, new: true }))!;
  }

  /** Rebuild adapters from current settings (after config or integration changes). */
  invalidate() {
    for (const a of this.adapters.values()) (a as { dispose?(): void }).dispose?.();
    this.adapters.clear();
  }

  private secret(enc?: string | null) {
    try {
      return enc ? decrypt(enc) : '';
    } catch {
      return '';
    }
  }

  async adapter(id: BrokerId): Promise<BrokerAdapter> {
    const o = this.override.get(id);
    if (o) return o;
    let a = this.adapters.get(id);
    if (a) return a;
    const c = await this.config();
    if (id === 'deriv') a = new DerivAdapter({ appId: c.deriv?.appId ?? '', token: this.secret(c.deriv?.tokenEnc), currency: c.deriv?.currency ?? 'USD', multipliers: { crypto: c.deriv?.multipliers?.crypto ?? 50, forex: c.deriv?.multipliers?.forex ?? 50, metals: c.deriv?.multipliers?.metals ?? 50 } });
    else a = new OandaBrokerAdapter({ token: env.OANDA_API_TOKEN, accountId: env.OANDA_ACCOUNT_ID, environment: env.OANDA_ENV });
    this.adapters.set(id, a);
    return a;
  }

  /** Where a REAL-account order for `symbol` goes. */
  async routeFor(symbol: string): Promise<Route> {
    return this.routeForCategory(instrumentOf(symbol)?.category ?? (/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol) && !symbol.endsWith('USDT') ? (symbol.startsWith('X') ? 'metals' : 'forex') : 'crypto'));
  }

  async routeForCategory(cat: InstrumentCategory): Promise<Route> {
    const c = await this.config();
    return ((c.routes as Record<string, Route> | undefined)?.[cat] ?? 'internal') as Route;
  }

  /** Throws unless an external broker order is allowed right now. */
  assertAllowed(intent: 'OPEN' | 'REDUCE') {
    const reasons: string[] = [];
    if (!isLiveTradingEnabledByEnv()) reasons.push('LIVE_TRADING_ENABLED is not true');
    if (env.MARKET_DATA_SOURCE === 'simulated') reasons.push('Simulated market data is active');
    const s = tradingState.get();
    if (intent === 'OPEN') {
      if (s.emergencyShutdown) reasons.push('Emergency shutdown is active');
      if (!s.tradingEnabled) reasons.push('New trades are stopped');
    }
    if (reasons.length) throw new LiveTradingDisabledError(reasons.join('; '));
  }

  async test(id: BrokerId): Promise<BrokerTestResult> {
    const a = await this.adapter(id);
    const r = a.configured() ? await a.test() : { ok: false, message: `${a.name} is not configured` };
    await BrokerConfigModel.updateOne({ key: 'brokers' }, { $set: { [`${id}.lastTest`]: { ...r, at: new Date() } } });
    return r;
  }

  async view() {
    const c = await this.config();
    const deriv = await this.adapter('deriv');
    const oanda = await this.adapter('oanda');
    const open = await PositionModel.aggregate<{ _id: string; n: number }>([{ $match: { mode: 'REAL', status: 'OPEN', broker: { $nin: [null, 'internal'] } } }, { $group: { _id: '$broker', n: { $sum: 1 } } }]);
    return {
      liveTradingEnabledByEnv: isLiveTradingEnabledByEnv(),
      simulatedMarketData: env.MARKET_DATA_SOURCE === 'simulated',
      routes: { crypto: c.routes?.crypto ?? 'internal', forex: c.routes?.forex ?? 'internal', metals: c.routes?.metals ?? 'internal' },
      brokers: [
        {
          id: 'deriv',
          name: 'Deriv',
          configured: deriv.configured(),
          supports: ['crypto', 'forex', 'metals'],
          settings: { appId: c.deriv?.appId ?? '', token: c.deriv?.tokenEnc ? mask(this.secret(c.deriv.tokenEnc)).slice(-8) : '', currency: c.deriv?.currency ?? 'USD', multipliers: c.deriv?.multipliers ?? { crypto: 50, forex: 50, metals: 50 } },
          lastTest: c.deriv?.lastTest ?? null,
          openPositions: open.find((o) => o._id === 'deriv')?.n ?? 0,
        },
        { id: 'oanda', name: 'OANDA', configured: oanda.configured(), supports: ['forex', 'metals'], settings: { environment: env.OANDA_ENV, accountId: env.OANDA_ACCOUNT_ID }, lastTest: c.oanda?.lastTest ?? null, openPositions: open.find((o) => o._id === 'oanda')?.n ?? 0 },
      ],
    };
  }

  async updateDeriv(input: { appId?: string; token?: string; currency?: string; multipliers?: Partial<Record<InstrumentCategory, number>> }, adminId: string) {
    const $set: Record<string, unknown> = { updatedBy: adminId };
    if (input.appId !== undefined) $set['deriv.appId'] = input.appId.trim();
    if (input.token) $set['deriv.tokenEnc'] = encrypt(input.token.trim());
    if (input.currency) $set['deriv.currency'] = input.currency;
    for (const [k, v] of Object.entries(input.multipliers ?? {})) $set[`deriv.multipliers.${k}`] = v;
    $set['deriv.lastTest'] = null;
    await BrokerConfigModel.updateOne({ key: 'brokers' }, { $set }, { upsert: true });
    this.invalidate();
    return this.view();
  }

  /**
   * Change where an asset class executes. Routing to a broker requires the kill switch on, real
   * market data, support for the asset class and a passing connection test (with a USD account).
   */
  async setRoute(category: InstrumentCategory, route: Route, adminId: string) {
    if (!CATEGORIES.includes(category)) throw new AppError(400, 'Unknown asset class', 'VALIDATION_ERROR');
    const prev = await this.routeForCategory(category);
    if (prev !== route) {
      const open = await PositionModel.countDocuments({ mode: 'REAL', status: 'OPEN', broker: prev });
      const cats = await PositionModel.find({ mode: 'REAL', status: 'OPEN', broker: prev }).select('symbol').lean();
      if (open && cats.some((p) => (instrumentOf(p.symbol)?.category ?? 'crypto') === category)) throw new AppError(409, `Close the open ${category} positions on ${prev} before changing the route`, 'POSITIONS_OPEN');
    }
    if (route !== 'internal') {
      this.assertAllowed('OPEN');
      const a = await this.adapter(route);
      const probe = category === 'crypto' ? 'BTC/USDT' : category === 'forex' ? 'EUR/USD' : 'XAU/USD';
      if (!a.supports(probe)) throw new AppError(400, `${a.name} does not support ${category}`, 'VALIDATION_ERROR');
      const t = await this.test(route);
      if (!t.ok) throw new AppError(409, `Connection test failed: ${t.message}`, 'BROKER_TEST_FAILED');
      if (t.currency && t.currency !== 'USD') throw new AppError(409, `${a.name} account currency must be USD (is ${t.currency})`, 'BROKER_CURRENCY');
    }
    await BrokerConfigModel.updateOne({ key: 'brokers' }, { $set: { [`routes.${category}`]: route, updatedBy: adminId } }, { upsert: true });
    if (route !== 'internal') void notificationService.notify('LIVE_MODE_ENABLED', `REAL ${category} orders now routed to ${route}`, `Changed by admin ${adminId}`);
    return this.view();
  }

  /**
   * Job: positions closed at the broker (stop loss, take profit, stop-out) are finalized locally
   * with the broker's own result; broker positions we have no record of are reported.
   */
  async sync(finalize: (positionId: string, pnlUsd: number | undefined, closePrice: number | undefined, reason: string) => Promise<unknown>) {
    const open = await PositionModel.find({ mode: 'REAL', status: 'OPEN', broker: { $nin: [null, 'internal'] } }).limit(200);
    for (const p of open) {
      try {
        const a = await this.adapter(p.broker as BrokerId);
        const st = await a.status(p.brokerRef!);
        if (!st.open) await finalize(p._id.toString(), st.pnlUsd, st.closePrice, `Closed at ${a.name}`);
      } catch (err) {
        logger.warn({ position: p._id.toString(), err: errorMessage(err) }, 'Broker status check failed');
      }
    }
    for (const id of ['deriv', 'oanda'] as BrokerId[]) {
      const c = await this.config();
      if (!Object.values(c.routes ?? {}).includes(id)) continue;
      try {
        const refs = await (await this.adapter(id)).openRefs();
        const known = new Set((await PositionModel.find({ broker: id, brokerRef: { $in: refs } }).select('brokerRef').lean()).map((x) => x.brokerRef));
        const orphans = refs.filter((r) => !known.has(r));
        if (orphans.length) {
          await SystemEventModel.create({ type: 'BROKER_RECONCILIATION', level: 'error', component: id, message: `${orphans.length} open ${id} position(s) have no local record`, details: { refs: orphans } }).catch(() => undefined);
          void notificationService.notify('RECONCILIATION', `${id}: unknown open positions`, `Broker refs: ${orphans.join(', ')}`, { throttleKey: `broker-orphans:${id}`, throttleMs: 3_600_000 });
        }
      } catch (err) {
        logger.warn({ broker: id, err: errorMessage(err) }, 'Broker reconciliation failed');
      }
    }
  }
}

export const brokerService = new BrokerService();
