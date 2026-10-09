import { BrokerConnectionModel, type BrokerConnectionDoc } from '../../models/BrokerConnection';
import { BrokerAccountSnapshotModel, BrokerSyncLogModel, MarketInstrumentModel, MarketQuoteModel } from '../../models/BrokerRecords';
import { PositionModel } from '../../models/Position';
import { TradeModel } from '../../models/Trade';
import { notificationService } from '../../notifications/NotificationService';
import { eventBus } from '../../utils/eventBus';
import { errorMessage } from '../../utils/logger';
import type { BrokerAccountInfo, BrokerQuote, ClosedPositionResult, InstrumentSpec } from '../core/types';
import { brokerRegistry, logBrokerEvent, recordConnectionError } from './BrokerRegistry';

const startOfUtcDay = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const startOfUtcWeek = (d = new Date()) => new Date(startOfUtcDay(d).getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000);

/** Publish a user-scoped broker event (Socket.IO routes it to that user's room only). */
export function publishBroker(user: string, connection: string, kind: string, data: Record<string, unknown>) {
  eventBus.publish('broker', { user, connection, kind, ...data });
}

/** Trip a connection's circuit breaker: no new orders until a user/admin resets it. */
export async function tripConnection(conn: { _id: unknown; user: unknown }, reason: string) {
  const r = await BrokerConnectionModel.updateOne({ _id: conn._id, 'breaker.tripped': { $ne: true } }, { $set: { breaker: { tripped: true, reason, at: new Date() } } });
  if (r.modifiedCount) {
    await logBrokerEvent(conn, 'CIRCUIT_BREAKER', reason, undefined, 'error');
    publishBroker(String(conn.user), String(conn._id), 'breaker', { tripped: true, reason });
    void notificationService.notify('CIRCUIT_BREAKER', 'Broker account halted', reason, { throttleKey: `broker-cb:${String(conn._id)}`, throttleMs: 600_000 });
  }
}

// ---------------------------------------------------------------- market data

export class BrokerMarketDataService {
  private quotes = new Map<string, { quote: BrokerQuote; receivedAt: number }>();
  private persisted = new Map<string, number>();

  onQuote(conn: { id: string; user: string }, q: BrokerQuote) {
    const key = `${conn.id}:${q.brokerSymbol}`;
    const receivedAt = q.receivedAt ?? Date.now();
    const prev = this.quotes.get(key);
    if (prev && prev.receivedAt > receivedAt) return; // never replace a newer quote with a replayed one
    this.quotes.set(key, { quote: q, receivedAt });
    publishBroker(conn.user, conn.id, 'quote', { quote: q });
    if (Date.now() - (this.persisted.get(key) ?? 0) > 5_000) {
      this.persisted.set(key, Date.now());
      void MarketQuoteModel.updateOne({ connection: conn.id, brokerSymbol: q.brokerSymbol }, { $set: { symbol: q.symbol, bid: q.bid, ask: q.ask, last: q.last, quoteTime: new Date(q.timestamp), receivedAt: new Date() } }, { upsert: true }).catch(() => undefined);
    }
  }

  /** Latest in-memory quote and its age (ms since received). */
  quote(connectionId: string, brokerSymbol: string) {
    const q = this.quotes.get(`${connectionId}:${brokerSymbol}`);
    return q ? { ...q.quote, ageMs: Date.now() - q.receivedAt } : null;
  }

  clear(connectionId?: string) {
    if (!connectionId) return this.quotes.clear();
    for (const k of [...this.quotes.keys()]) if (k.startsWith(`${connectionId}:`)) this.quotes.delete(k);
  }

  async syncInstruments(conn: BrokerConnectionDoc) {
    const t0 = Date.now();
    const adapter = await brokerRegistry.get(conn);
    const list = await adapter.getInstruments();
    for (const i of list.slice(0, 3000)) {
      await MarketInstrumentModel.updateOne({ connection: conn._id, brokerSymbol: i.brokerSymbol }, { $set: { provider: conn.provider, symbol: i.symbol, name: i.name, category: i.category, tradable: i.tradable, marketOpen: i.marketOpen, spec: { ...i, raw: undefined }, updatedAt: new Date() } }, { upsert: true });
    }
    await BrokerSyncLogModel.create({ connection: conn._id, user: conn.user, kind: 'instruments', ok: true, durationMs: Date.now() - t0, message: `${list.length} instruments` });
    return list.length;
  }

  async instrument(connectionId: string, brokerSymbol: string): Promise<InstrumentSpec | null> {
    const d = await MarketInstrumentModel.findOne({ connection: connectionId, brokerSymbol }).lean();
    return d ? ({ ...(d.spec as InstrumentSpec), tradable: d.tradable ?? false, marketOpen: d.marketOpen ?? null } as InstrumentSpec) : null;
  }
}

// ---------------------------------------------------------------- account

export class BrokerAccountService {
  /** Pull account figures from the broker, store a snapshot and check for unexplained balance changes. */
  async sync(conn: BrokerConnectionDoc, account?: BrokerAccountInfo, opts: { checkBalance?: boolean } = {}) {
    const t0 = Date.now();
    try {
      const a = account ?? (await (await brokerRegistry.get(conn)).getAccount());
      if (a.environment !== conn.environment) {
        await tripConnection(conn, `Broker reports a ${a.environment} account for a ${conn.environment} connection`);
        await BrokerConnectionModel.updateOne({ _id: conn._id }, { $set: { tradingEnabled: false, liveEnabled: false, status: 'ERROR' } });
        return null;
      }
      const equity = a.equity ?? a.balance;
      const now = new Date();
      const $set: Record<string, unknown> = { balance: a.balance, equity, margin: a.margin, freeMargin: a.freeMargin, marginLevel: a.marginLevel, leverage: a.leverage, currency: a.currency || conn.currency, lastSyncAt: now, status: 'CONNECTED', consecutiveFailures: conn.consecutiveFailures };
      if (!conn.dayStartAt || conn.dayStartAt < startOfUtcDay(now)) Object.assign($set, { dayStartAt: startOfUtcDay(now), dayStartEquity: equity });
      if (!conn.weekStartAt || conn.weekStartAt < startOfUtcWeek(now)) Object.assign($set, { weekStartAt: startOfUtcWeek(now), weekStartEquity: equity });
      if (conn.status !== 'CONNECTED') $set.recoveredAt = now;
      // Only after positions were reconciled (job), so settled trades are already booked.
      if (opts.checkBalance) await this.checkBalance(conn, a.balance);
      await BrokerConnectionModel.updateOne({ _id: conn._id }, { $set });
      const last = await BrokerAccountSnapshotModel.findOne({ connection: conn._id }).sort({ at: -1 }).lean();
      if (!last || now.getTime() - new Date(last.at).getTime() > 60_000) {
        await BrokerAccountSnapshotModel.create({ connection: conn._id, user: conn.user, balance: a.balance, equity, margin: a.margin, freeMargin: a.freeMargin, currency: a.currency, openPositions: await PositionModel.countDocuments({ connection: conn._id, status: 'OPEN' }), at: now });
      }
      await BrokerSyncLogModel.create({ connection: conn._id, user: conn.user, kind: 'account', ok: true, durationMs: Date.now() - t0 });
      publishBroker(conn.user.toString(), conn._id.toString(), 'account', { balance: a.balance, equity, margin: a.margin, freeMargin: a.freeMargin, currency: a.currency });
      return a;
    } catch (err) {
      await recordConnectionError(conn, err);
      await BrokerSyncLogModel.create({ connection: conn._id, user: conn.user, kind: 'account', ok: false, durationMs: Date.now() - t0, message: errorMessage(err).slice(0, 300) });
      throw err;
    }
  }

  /**
   * Unexpected balance change: compare the change since the last snapshot with the cash flows of
   * trades this platform made (Deriv: stakes paid / proceeds received; MT5: realized P&L).
   * Anything beyond the tolerance halts new orders on the connection until reviewed.
   */
  private async checkBalance(conn: BrokerConnectionDoc, balance: number) {
    const last = await BrokerAccountSnapshotModel.findOne({ connection: conn._id }).sort({ at: -1 }).lean();
    if (!last || last.balance === undefined || last.balance === null) return;
    const since = new Date(last.at);
    const opened = await PositionModel.find({ connection: conn._id, openedAt: { $gt: since } }).select('brokerData').lean();
    const closed = await TradeModel.find({ connection: conn._id, closedAt: { $gt: since } }).select('netPnl position').lean();
    let explained = 0;
    if (conn.provider === 'deriv') {
      explained -= opened.reduce((s, p) => s + Number((p.brokerData as { cost?: number } | undefined)?.cost ?? 0), 0);
      for (const t of closed) {
        const p = await PositionModel.findById(t.position).select('brokerData').lean();
        explained += Number((p?.brokerData as { cost?: number } | undefined)?.cost ?? 0) + (t.netPnl ?? 0);
      }
    } else explained = closed.reduce((s, t) => s + (t.netPnl ?? 0), 0);
    const unexplained = balance - last.balance - explained;
    const tol = Math.max(1, Math.abs(last.balance) * (conn.riskLimits?.balanceChangeTolerancePct ?? 0.01));
    if (Math.abs(unexplained) > tol) await tripConnection(conn, `Unexpected balance change of ${unexplained.toFixed(2)} ${conn.currency ?? ''} (not explained by platform trades). Review the account before resuming.`);
  }
}

// ---------------------------------------------------------------- health

export class BrokerHealthService {
  /** Refresh health figures and mark disconnected connections. */
  async check(conn: BrokerConnectionDoc) {
    const adapter = brokerRegistry.peek(conn._id.toString());
    const h = adapter?.health();
    const $set: Record<string, unknown> = {};
    if (h) {
      $set.latencyMs = h.latencyMs;
      if (h.lastMessageAt) $set.lastHeartbeatAt = new Date(h.lastMessageAt);
      if (!h.connected && conn.status === 'CONNECTED') {
        $set.status = 'DISCONNECTED';
        $set.lastError = h.lastError ?? 'Connection lost';
        $set.lastErrorAt = new Date();
        $set.disconnectedAt = new Date();
        await logBrokerEvent(conn, 'DISCONNECTED', String($set.lastError), undefined, 'warn');
        publishBroker(conn.user.toString(), conn._id.toString(), 'status', { status: 'DISCONNECTED', error: $set.lastError });
      } else if (h.connected && conn.status === 'DISCONNECTED') {
        $set.status = 'CONNECTED';
        $set.recoveredAt = new Date();
        await logBrokerEvent(conn, 'RECOVERED', 'Connection restored');
        publishBroker(conn.user.toString(), conn._id.toString(), 'status', { status: 'CONNECTED' });
      }
    }
    if (Object.keys($set).length) await BrokerConnectionModel.updateOne({ _id: conn._id }, { $set });
    return h ?? { connected: false, latencyMs: null, lastMessageAt: null, rateLimitedUntil: null, lastError: 'Not connected' };
  }
}

// ---------------------------------------------------------------- positions

export class BrokerPositionService {
  /**
   * A position/contract closed at the broker: book exactly the broker's realized P&L, once
   * (atomic OPEN→CLOSED transition + unique trade per broker reference).
   */
  async onClosed(connectionId: string, r: ClosedPositionResult) {
    if (!r.closed) return null;
    if (r.realizedPnl === undefined) {
      // Closed at the broker but the realized P&L is not reported yet: never book a guessed result.
      // Reconciliation books the trade once the broker reports the closing deal(s).
      await PositionModel.updateOne({ connection: connectionId, brokerRef: r.brokerPositionId, status: 'OPEN' }, { $set: { 'brokerData.closeConfirmedAt': new Date(r.closedAt ?? Date.now()), currentPrice: r.exitPrice } });
      return null;
    }
    const pos = await PositionModel.findOneAndUpdate({ connection: connectionId, brokerRef: r.brokerPositionId, status: 'OPEN' }, { $set: { status: 'CLOSED', closedAt: new Date(r.closedAt ?? Date.now()), exitReason: r.reason ?? 'Closed at broker', realizedPnl: r.realizedPnl ?? 0, unrealizedPnl: 0, currentPrice: r.exitPrice } }, { returnDocument: 'after' });
    if (!pos) return null;
    let trade;
    try {
      trade = await TradeModel.create({
        mode: pos.mode,
        user: pos.user,
        connection: pos.connection,
        exchange: pos.exchange,
        symbol: pos.symbol,
        direction: pos.direction,
        strategyKey: pos.strategyKey,
        timeframe: pos.timeframe,
        amount: pos.amount,
        entryPrice: pos.entryPrice,
        exitPrice: r.exitPrice ?? pos.currentPrice ?? pos.entryPrice,
        grossPnl: r.realizedPnl ?? 0,
        fees: 0,
        netPnl: r.realizedPnl ?? 0,
        returnPct: (pos.brokerData as { cost?: number } | undefined)?.cost ? (r.realizedPnl ?? 0) / Number((pos.brokerData as { cost: number }).cost) : undefined,
        exitReason: r.reason ?? 'Closed at broker',
        position: pos._id,
        signal: pos.signal,
        aiAnalysis: pos.aiAnalysis,
        entryOrder: pos.entryOrder,
        broker: pos.broker,
        brokerRef: pos.brokerRef,
        openedAt: pos.openedAt,
        closedAt: new Date(r.closedAt ?? Date.now()),
      });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
    eventBus.publish('position', pos.toJSON());
    if (trade) eventBus.publish('trade', trade.toJSON());
    await logBrokerEvent({ _id: pos.connection, user: pos.user }, 'POSITION_CLOSED', `${pos.symbol} ${pos.direction} closed: P&L ${(r.realizedPnl ?? 0).toFixed(2)}`, { brokerRef: r.brokerPositionId, reason: r.reason });
    return trade ?? null;
  }

  async onUpdate(connectionId: string, p: { brokerPositionId: string; currentPrice?: number; unrealizedPnl?: number }) {
    await PositionModel.updateOne({ connection: connectionId, brokerRef: p.brokerPositionId, status: 'OPEN' }, { $set: { currentPrice: p.currentPrice, unrealizedPnl: p.unrealizedPnl ?? 0 } });
  }
}

export const brokerMarketData = new BrokerMarketDataService();
export const brokerAccounts = new BrokerAccountService();
export const brokerHealth = new BrokerHealthService();
export const brokerPositions = new BrokerPositionService();

// Fan adapter stream events into the services.
brokerRegistry.onEvent((conn, e) => {
  if (e.type === 'quote') brokerMarketData.onQuote(conn, e.quote);
  else if (e.type === 'position-closed') void brokerPositions.onClosed(conn.id, e.result).catch(() => undefined);
  else if (e.type === 'position-update') void brokerPositions.onUpdate(conn.id, e.position).catch(() => undefined);
  else if (e.type === 'status') publishBroker(conn.user, conn.id, 'status', { connected: e.connected, info: e.info });
  else if (e.type === 'account') void BrokerConnectionModel.findById(conn.id).then((c) => c && brokerAccounts.sync(c, e.account)).catch(() => undefined);
});
