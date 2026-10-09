import cron from 'node-cron';
import { env } from '../config/env';
import { tradingEngine } from '../execution/TradingEngine';
import { positionManager } from '../execution/PositionManager';
import { orderExecutionService } from '../execution/OrderExecutionService';
import { portfolioService } from '../portfolio/PortfolioService';
import { reconciliationService } from '../services/ReconciliationService';
import { systemHealth } from '../services/HealthService';
import { tradingState } from '../services/TradingState';
import { circuitBreaker } from '../risk/CircuitBreaker';
import { exchangeRegistry } from '../exchanges/registry';
import { OrderModel } from '../models/Order';
import { SystemEventModel } from '../models/SystemEvent';
import { notificationService } from '../notifications/NotificationService';
import { arbitrageService } from '../services/ArbitrageService';
import { paymentService } from '../payments/PaymentService';
import { brokerService } from '../brokers/BrokerService';
import { brokerReconciliation } from '../brokers/services/BrokerReconciliationService';
import { logger, errorMessage } from '../utils/logger';

type Task = ReturnType<typeof cron.schedule>;

/**
 * Background jobs (node-cron, in-process). The app runs as a single trading-engine process
 * under PM2 (fork mode, 1 instance) so jobs never run twice. If you scale the API horizontally,
 * keep jobs in exactly one process (JOBS_ENABLED=true only there) or move them to BullMQ + Redis.
 */
export class JobScheduler {
  private tasks: Task[] = [];
  private busy = new Set<string>();
  private lastLargeLossCheck = Date.now();

  private job(name: string, expr: string, fn: () => Promise<unknown>) {
    const t = cron.schedule(expr, async () => {
      if (this.busy.has(name)) return; // no overlapping runs
      this.busy.add(name);
      try {
        await fn();
      } catch (err) {
        logger.error({ job: name, err: errorMessage(err) }, 'Job failed');
        await SystemEventModel.create({ type: 'JOB_FAILED', level: 'error', component: name, message: errorMessage(err) }).catch(() => undefined);
      } finally {
        this.busy.delete(name);
      }
    });
    this.tasks.push(t);
  }

  start() {
    // Strategy scanning shortly after each minute boundary (candles close on the minute).
    this.job('strategy-scan', '5 * * * * *', () => tradingEngine.scanAll());
    // Position monitor: stop-loss / take-profit / trailing stops.
    // PAPER (system paper book + demo accounts) and REAL (client accounts) are always monitored.
    this.job('position-monitor', '*/2 * * * * *', async () => {
      await positionManager.monitor('PAPER');
      await positionManager.monitor('REAL');
      if (tradingState.get().mode === 'LIVE') await positionManager.monitor('LIVE');
    });
    // External brokers: positions closed broker-side (SL/TP) + reconciliation of open positions.
    this.job('broker-sync', '*/15 * * * * *', () => brokerService.sync((id, pnl, px, reason) => positionManager.closeFromBroker(id, pnl, px, reason)));
    // User broker accounts: health checks + reconciliation against the broker (authoritative).
    this.job('broker-accounts', '45 * * * * *', () => brokerReconciliation.runAll());
    // M-Pesa: re-query deposits whose callback never arrived; expire stale requests.
    this.job('payments-reconcile', '*/15 * * * * *', () => paymentService.reconcilePending());
    // Risk checks: drawdown limits and clock sync.
    this.job('risk-checks', '*/15 * * * * *', () => this.riskChecks());
    // Portfolio snapshots.
    this.job('portfolio-snapshot', '0 */5 * * * *', async () => {
      await portfolioService.snapshot('PAPER');
      if (tradingState.get().mode === 'LIVE') await portfolioService.snapshot('LIVE');
    });
    // Stale-order checks: re-verify non-terminal orders.
    this.job('stale-orders', '30 * * * * *', () => this.staleOrders());
    // Reconciliation with the exchange (LIVE only).
    this.job('reconciliation', '0 */2 * * * *', () => reconciliationService.run());
    // Health (also runs the risk-engine self-test).
    this.job('health', '*/30 * * * * *', () => systemHealth());
    // Arbitrage monitor (only acts if the arbitrage strategy is enabled).
    this.job('arbitrage', '*/10 * * * * *', () => arbitrageService.scan());
    tradingEngine.start();
    logger.info('Job scheduler started');
  }

  stop() {
    for (const t of this.tasks) t.stop();
    this.tasks = [];
    tradingEngine.stop();
  }

  private async riskChecks() {
    const s = tradingState.get();
    const p = portfolioService.view(await portfolioService.revalue(s.mode));
    const wasDaily = circuitBreaker.isTripped('DAILY_LOSS_LIMIT');
    circuitBreaker.checkDrawdown(p.dailyDrawdownPct, p.weeklyDrawdownPct, s.risk.maxDailyLoss, s.risk.maxWeeklyLoss);
    if (!wasDaily && circuitBreaker.isTripped('DAILY_LOSS_LIMIT')) void notificationService.notify('DAILY_LOSS_LIMIT', 'Daily loss limit reached', `Daily drawdown ${(p.dailyDrawdownPct * 100).toFixed(2)}% - new trades stopped`);
    if (p.dailyDrawdownPct >= s.risk.maxDailyLoss * 0.5 && Date.now() - this.lastLargeLossCheck > 3_600_000) {
      this.lastLargeLossCheck = Date.now();
      void notificationService.notify('LARGE_LOSS', 'Large loss warning', `Daily drawdown ${(p.dailyDrawdownPct * 100).toFixed(2)}% (limit ${(s.risk.maxDailyLoss * 100).toFixed(2)}%)`);
    }
    if (s.mode === 'LIVE') {
      try {
        const a = exchangeRegistry.private(env.DEFAULT_EXCHANGE);
        const t0 = Date.now();
        const server = await a.getServerTime();
        circuitBreaker.checkClockDrift(server - (t0 + Date.now()) / 2, env.MAX_CLOCK_DRIFT_MS);
      } catch (err) {
        circuitBreaker.recordApiError(errorMessage(err));
      }
    }
  }

  private async staleOrders() {
    const cutoff = new Date(Date.now() - 60_000);
    const stale = await OrderModel.find({ status: { $in: ['SUBMITTED', 'OPEN', 'PARTIALLY_FILLED', 'UNKNOWN'] }, $or: [{ lastCheckedAt: { $lt: cutoff } }, { lastCheckedAt: null }] }).limit(50);
    for (const o of stale) {
      if (o.mode === 'LIVE' && o.exchangeOrderId) await orderExecutionService.verify(o);
      else if (o.mode === 'PAPER' && o.type === 'limit') {
        // Paper resting limit orders: older than 24h -> expire.
        if (Date.now() - o.createdAt.getTime() > 86_400_000) {
          o.status = 'EXPIRED';
          o.closedAt = new Date();
        }
        o.lastCheckedAt = new Date();
        await o.save();
      }
    }
  }
}

export const jobScheduler = new JobScheduler();
