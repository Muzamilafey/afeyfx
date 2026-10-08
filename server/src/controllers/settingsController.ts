import type { Request, Response } from 'express';
import { z } from 'zod';
import { env, isLiveTradingEnabledByEnv } from '../config/env';
import { SettingsService } from '../services/SettingsService';
import { tradingState } from '../services/TradingState';
import { audit } from '../services/AuditService';
import { NotificationModel } from '../models/Notification';
import { notificationService } from '../notifications/NotificationService';

export const settingsSchemas = {
  ai: z.object({ enabled: z.boolean().optional(), model: z.string().optional(), minConfidence: z.number().optional(), requireAgreement: z.boolean().optional() }),
};

export const settingsController = {
  get(_req: Request, res: Response) {
    const s = tradingState.get();
    // Never includes secrets - only whether integrations are configured.
    res.json({
      ...s,
      liveTradingEnabledByEnv: isLiveTradingEnabledByEnv(),
      exchange: env.DEFAULT_EXCHANGE,
      integrations: { anthropic: !!env.ANTHROPIC_API_KEY, telegram: !!env.TELEGRAM_BOT_TOKEN && !!env.TELEGRAM_CHAT_ID, binance: !!env.BINANCE_API_KEY, binanceTestnet: env.BINANCE_TESTNET },
    });
  },
  async updateAi(req: Request, res: Response) {
    const ai = await SettingsService.updateAi(req.body);
    await audit(req, { action: 'AI_SETTINGS_UPDATED', details: req.body });
    res.json({ ai });
  },
};

export const notificationController = {
  async list(req: Request, res: Response) {
    res.json({ notifications: await NotificationModel.find().sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit ?? 50), 200)).lean() });
  },
  async markRead(req: Request, res: Response) {
    await NotificationModel.updateOne({ _id: req.params.id }, { $set: { read: true } });
    res.json({ ok: true });
  },
  async test(req: Request, res: Response) {
    await notificationService.notify('SYSTEM', 'Test notification', `Triggered by ${req.user!.email}`);
    res.json({ ok: true, telegramConfigured: notificationService.telegram.configured });
  },
};
