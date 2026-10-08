import { exchangeRegistry } from '../exchanges/registry';
import { OrderModel } from '../models/Order';
import { PositionModel } from '../models/Position';
import { PortfolioModel } from '../models/Portfolio';
import { RiskEventModel } from '../models/RiskEvent';
import { circuitBreaker } from '../risk/CircuitBreaker';
import { orderExecutionService } from '../execution/OrderExecutionService';
import { notificationService } from '../notifications/NotificationService';
import { tradingState } from './TradingState';
import { errorMessage } from '../utils/logger';
import type { ExchangeAdapter } from '../exchanges/ExchangeAdapter';
import { env } from '../config/env';

export interface Discrepancy {
  kind: 'ORDER_STATUS' | 'MISSING_ORDER' | 'UNEXPECTED_ORDER' | 'BALANCE' | 'POSITION' | 'MISSING_FILLS';
  severity: 'WARNING' | 'CRITICAL';
  detail: string;
}

/**
 * Compares the local database against the exchange account (LIVE mode). Serious discrepancies
 * trip the circuit breaker (no new trades) and alert operators.
 */
export class ReconciliationService {
  constructor(private balanceTolerancePct = 0.01) {}

  async run(exchange = env.DEFAULT_EXCHANGE, adapter: ExchangeAdapter = exchangeRegistry.private(exchange)): Promise<{ discrepancies: Discrepancy[]; skipped?: string }> {
    if (tradingState.get().mode !== 'LIVE') return { discrepancies: [], skipped: 'Not in LIVE mode' };
    if (!adapter.hasCredentials) return { discrepancies: [], skipped: 'No credentials' };
    const d: Discrepancy[] = [];
    try {
      // 1) Orders: local open orders vs exchange open orders
      const localOpen = await OrderModel.find({ mode: 'LIVE', exchange, status: { $in: ['SUBMITTED', 'OPEN', 'PARTIALLY_FILLED', 'UNKNOWN'] } });
      const exOpen = await adapter.getOpenOrders();
      const exIds = new Set(exOpen.map((o) => o.id));
      const exClientIds = new Set(exOpen.map((o) => o.clientOrderId).filter(Boolean));
      for (const o of localOpen) {
        if (o.exchangeOrderId && exIds.has(o.exchangeOrderId)) continue;
        if (exClientIds.has(o.idempotencyKey)) continue;
        // Not open on exchange: fetch the real status.
        try {
          if (o.exchangeOrderId) {
            await orderExecutionService.verify(o);
            d.push({ kind: 'ORDER_STATUS', severity: 'WARNING', detail: `Order ${o.idempotencyKey} status corrected to ${o.status}` });
          } else {
            d.push({ kind: 'MISSING_ORDER', severity: 'CRITICAL', detail: `Order ${o.idempotencyKey} has no exchange id and is not open on exchange` });
          }
        } catch (err) {
          d.push({ kind: 'MISSING_ORDER', severity: 'CRITICAL', detail: `Order ${o.idempotencyKey}: ${errorMessage(err)}` });
        }
      }
      const knownIds = new Set((await OrderModel.find({ mode: 'LIVE', exchange, exchangeOrderId: { $in: [...exIds] } }).select({ exchangeOrderId: 1 }).lean()).map((o) => o.exchangeOrderId));
      for (const o of exOpen) if (!knownIds.has(o.id)) d.push({ kind: 'UNEXPECTED_ORDER', severity: 'CRITICAL', detail: `Exchange order ${o.id} (${o.symbol} ${o.side} ${o.amount}) not in local DB` });

      // 2) Filled orders must have fills recorded
      const filled = await OrderModel.find({ mode: 'LIVE', exchange, status: 'FILLED', closedAt: { $gte: new Date(Date.now() - 86_400_000) } });
      for (const o of filled) await orderExecutionService.syncFills(o);

      // 3) Positions (derivatives) / base balances (spot)
      const localPos = await PositionModel.find({ mode: 'LIVE', exchange, status: 'OPEN' });
      const exPos = await adapter.getPositions();
      if (exPos.length) {
        for (const p of exPos) {
          const l = localPos.find((x) => x.symbol === p.symbol && x.direction === p.side);
          if (!l) d.push({ kind: 'POSITION', severity: 'CRITICAL', detail: `Unexpected exchange position ${p.symbol} ${p.side} ${p.amount}` });
          else if (Math.abs(l.amount - p.amount) / p.amount > 0.01) d.push({ kind: 'POSITION', severity: 'CRITICAL', detail: `${p.symbol} size local ${l.amount} vs exchange ${p.amount}` });
        }
        for (const l of localPos) if (!exPos.find((p) => p.symbol === l.symbol)) d.push({ kind: 'POSITION', severity: 'CRITICAL', detail: `Local position ${l.symbol} not found on exchange` });
      } else {
        const balances = await adapter.getBalance();
        for (const l of localPos) {
          const baseCcy = l.symbol.split('/')[0];
          const b = balances.find((x) => x.currency === baseCcy);
          if (l.direction === 'LONG' && (!b || b.total + 1e-9 < l.amount * 0.99)) d.push({ kind: 'POSITION', severity: 'CRITICAL', detail: `${l.symbol}: local long ${l.amount} but exchange ${baseCcy} balance ${b?.total ?? 0}` });
        }
        // 4) Quote balance vs local accounting
        const portfolio = await PortfolioModel.findOne({ mode: 'LIVE' });
        const quote = balances.find((x) => x.currency === (portfolio?.baseCurrency ?? 'USDT'));
        if (portfolio && quote) {
          const diff = Math.abs(quote.total - portfolio.balance);
          if (portfolio.balance > 0 && diff / portfolio.balance > this.balanceTolerancePct) {
            d.push({ kind: 'BALANCE', severity: 'CRITICAL', detail: `Quote balance local ${portfolio.balance.toFixed(2)} vs exchange ${quote.total.toFixed(2)}` });
            circuitBreaker.trip('UNEXPECTED_BALANCE_CHANGE', `Balance mismatch ${diff.toFixed(2)}`);
          }
          portfolio.lastExchangeBalance = quote.total;
          await portfolio.save();
        }
      }
    } catch (err) {
      circuitBreaker.recordApiError(errorMessage(err));
      return { discrepancies: [{ kind: 'MISSING_ORDER', severity: 'WARNING', detail: `Reconciliation incomplete: ${errorMessage(err)}` }] };
    }

    const critical = d.filter((x) => x.severity === 'CRITICAL');
    if (critical.length) {
      circuitBreaker.trip('RECONCILIATION_MISMATCH', critical.map((c) => c.detail).join(' | ').slice(0, 500));
      await RiskEventModel.create({ type: 'RECONCILIATION_MISMATCH', severity: 'CRITICAL', mode: 'LIVE', message: `${critical.length} critical discrepancies`, details: d });
      void notificationService.notify('RECONCILIATION', 'Reconciliation mismatch - new trades stopped', critical.map((c) => c.detail).join('\n'));
    }
    return { discrepancies: d };
  }
}

export const reconciliationService = new ReconciliationService();
