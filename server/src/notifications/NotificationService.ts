import { NotificationModel } from '../models/Notification';
import { TelegramService } from './TelegramService';
import { eventBus } from '../utils/eventBus';
import { logger, errorMessage, redactSecrets } from '../utils/logger';

export type NotificationType =
  | 'TRADE_OPENED'
  | 'TRADE_CLOSED'
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'LARGE_LOSS'
  | 'DAILY_LOSS_LIMIT'
  | 'STRATEGY_DISABLED'
  | 'EXCHANGE_DISCONNECTED'
  | 'API_FAILURE'
  | 'EMERGENCY_SHUTDOWN'
  | 'LIVE_MODE_ENABLED'
  | 'LIVE_MODE_DISABLED'
  | 'CIRCUIT_BREAKER'
  | 'RECONCILIATION'
  | 'PAYMENT'
  | 'PAYMENT_ATTENTION'
  | 'SYSTEM';

const SEVERITY: Partial<Record<NotificationType, 'INFO' | 'WARNING' | 'CRITICAL'>> = {
  LARGE_LOSS: 'WARNING',
  DAILY_LOSS_LIMIT: 'CRITICAL',
  STRATEGY_DISABLED: 'WARNING',
  EXCHANGE_DISCONNECTED: 'CRITICAL',
  API_FAILURE: 'WARNING',
  EMERGENCY_SHUTDOWN: 'CRITICAL',
  LIVE_MODE_ENABLED: 'CRITICAL',
  CIRCUIT_BREAKER: 'CRITICAL',
  RECONCILIATION: 'CRITICAL',
  PAYMENT_ATTENTION: 'WARNING',
};

const ICON: Record<string, string> = { INFO: 'ℹ️', WARNING: '⚠️', CRITICAL: '🚨' };

/** Persists notifications, pushes them to the dashboard and to Telegram (if configured). */
export class NotificationService {
  private lastSent = new Map<string, number>();
  constructor(public telegram = new TelegramService()) {}

  async notify(type: NotificationType, title: string, message: string, opts: { throttleKey?: string; throttleMs?: number } = {}) {
    const severity = SEVERITY[type] ?? 'INFO';
    const safeTitle = redactSecrets(title);
    const safeMsg = redactSecrets(message);
    if (opts.throttleKey) {
      const last = this.lastSent.get(opts.throttleKey) ?? 0;
      if (Date.now() - last < (opts.throttleMs ?? 300_000)) return;
      this.lastSent.set(opts.throttleKey, Date.now());
    }
    eventBus.publish('system', { kind: 'notification', type, severity, title: safeTitle, message: safeMsg, at: new Date().toISOString() });
    try {
      const doc = await NotificationModel.create({ channel: this.telegram.configured ? 'TELEGRAM' : 'DASHBOARD', type, title: safeTitle, message: safeMsg, severity, status: 'PENDING' });
      if (this.telegram.configured) {
        const r = await this.telegram.send(`${ICON[severity]} ${safeTitle}\n${safeMsg}`);
        doc.status = r.ok ? 'SENT' : 'FAILED';
        doc.error = r.error;
      } else {
        doc.status = 'SKIPPED';
      }
      await doc.save();
    } catch (err) {
      logger.warn({ err: errorMessage(err), type }, 'Notification failed');
    }
  }
}

export const notificationService = new NotificationService();
