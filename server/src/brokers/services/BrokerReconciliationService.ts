import { BrokerConnectionModel, type BrokerConnectionDoc } from '../../models/BrokerConnection';
import { BrokerSyncLogModel } from '../../models/BrokerRecords';
import { OrderModel } from '../../models/Order';
import { PositionModel } from '../../models/Position';
import { errorMessage, logger } from '../../utils/logger';
import { brokerAccounts, brokerHealth, brokerPositions, tripConnection } from './BrokerDataServices';
import { brokerOrders } from './BrokerOrderService';
import { brokerRegistry, logBrokerEvent } from './BrokerRegistry';

/**
 * Periodic reconciliation (and after a restart). The BROKER's records are authoritative:
 *  1. UNKNOWN orders are resolved by looking them up at the broker.
 *  2. Positions open locally but gone at the broker are settled with the broker's final result.
 *  3. Broker positions with no local record are recorded (source: broker) and reported.
 *  4. A material disagreement that cannot be resolved halts new orders on the connection.
 */
export class BrokerReconciliationService {
  async run(conn: BrokerConnectionDoc) {
    const t0 = Date.now();
    const report = { resolvedOrders: 0, settled: 0, adopted: 0, unresolved: [] as string[] };
    try {
      const adapter = await brokerRegistry.get(conn);
      // 1) unknown orders
      for (const o of await OrderModel.find({ connection: conn._id, status: 'UNKNOWN' }).limit(50)) {
        const r = await adapter.lookupOrder(o.idempotencyKey, { brokerSymbol: o.symbol, since: (o.submittedAt ?? o.createdAt).getTime(), side: o.side as 'buy' | 'sell' }).catch(() => null);
        if (r && r.status !== 'UNKNOWN') {
          await brokerOrders.applyResult(conn, o, { clientOrderId: o.idempotencyKey, brokerSymbol: o.symbol, side: o.side as 'buy' | 'sell', product: ((o.riskEvaluation as { product?: string } | undefined)?.product as 'cfd') ?? (conn.provider === 'deriv' ? 'multiplier' : 'cfd'), type: 'market', volume: o.amount, stake: o.amount, stopLoss: o.stopPrice ?? undefined }, r, { strategyKey: o.strategyKey ?? undefined });
          report.resolvedOrders++;
        } else if (Date.now() - (o.submittedAt ?? o.createdAt).getTime() > 10 * 60_000) report.unresolved.push(`order ${o._id.toString()}`);
      }
      // 2) local open → broker
      const brokerPositionsNow = await adapter.getPositions();
      const brokerIds = new Set(brokerPositionsNow.map((p) => p.brokerPositionId));
      for (const p of await PositionModel.find({ connection: conn._id, status: 'OPEN' })) {
        if (brokerIds.has(p.brokerRef!)) continue;
        const closed = await adapter.getClosedPosition(p.brokerRef!).catch(() => null);
        if (closed?.closed) {
          await brokerPositions.onClosed(conn._id.toString(), closed);
          report.settled++;
        } else {
          // A close the broker already confirmed may wait briefly for its closing deal (realized P&L).
          const confirmedAt = (p.brokerData as { closeConfirmedAt?: Date } | undefined)?.closeConfirmedAt;
          if (!confirmedAt || Date.now() - new Date(confirmedAt).getTime() > 10 * 60_000) report.unresolved.push(`position ${p.brokerRef}`);
        }
      }
      // 3) broker → local
      for (const bp of brokerPositionsNow) {
        const known = await PositionModel.exists({ connection: conn._id, brokerRef: bp.brokerPositionId });
        if (known) {
          await brokerPositions.onUpdate(conn._id.toString(), bp);
          continue;
        }
        await PositionModel.create({ mode: conn.environment === 'real' ? 'LIVE' : 'DEMO', user: conn.user, connection: conn._id, broker: conn.provider, brokerRef: bp.brokerPositionId, exchange: conn.provider, symbol: bp.brokerSymbol, direction: bp.side === 'buy' ? 'LONG' : 'SHORT', amount: bp.volume, entryPrice: bp.entryPrice, currentPrice: bp.currentPrice, stopLoss: bp.stopLoss, takeProfit: bp.takeProfit, strategyKey: 'external', openedAt: bp.openedAt ? new Date(bp.openedAt) : new Date(), brokerData: { product: bp.product, source: 'broker' } }).catch((err) => {
          if ((err as { code?: number }).code !== 11000) throw err;
        });
        report.adopted++;
        await logBrokerEvent(conn, 'POSITION_ADOPTED', `Broker position ${bp.brokerPositionId} (${bp.symbol}) had no local record; recorded from the broker`, undefined, 'warn');
      }
      // Account figures + unexpected balance changes (after settlements are booked).
      await brokerAccounts.sync((await BrokerConnectionModel.findById(conn._id))!, undefined, { checkBalance: true });
      if (report.unresolved.length) await tripConnection(conn, `Reconciliation mismatch: ${report.unresolved.slice(0, 5).join(', ')}`);
      await BrokerSyncLogModel.create({ connection: conn._id, user: conn.user, kind: 'reconcile', ok: report.unresolved.length === 0, durationMs: Date.now() - t0, details: report });
      return report;
    } catch (err) {
      await BrokerSyncLogModel.create({ connection: conn._id, user: conn.user, kind: 'reconcile', ok: false, durationMs: Date.now() - t0, message: errorMessage(err).slice(0, 300) }).catch(() => undefined);
      throw err;
    }
  }

  /** Job: health + reconciliation for every active connection (also run once after a restart). */
  async runAll() {
    const conns = await BrokerConnectionModel.find({ status: { $in: ['CONNECTED', 'DISCONNECTED', 'PENDING'] }, $or: [{ tradingEnabled: true }, { lastSyncAt: { $ne: null } }] }).limit(500);
    for (const c of conns) {
      try {
        await brokerHealth.check(c);
        await this.run(c);
      } catch (err) {
        logger.warn({ connection: c._id.toString(), err: errorMessage(err) }, 'Broker reconciliation failed');
      }
    }
    return conns.length;
  }
}

export const brokerReconciliation = new BrokerReconciliationService();
