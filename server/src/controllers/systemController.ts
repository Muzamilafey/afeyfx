import type { Request, Response } from 'express';
import { z } from 'zod';
import { systemHealth } from '../services/HealthService';
import { EmergencyService } from '../services/EmergencyService';
import { LIVE_CONFIRMATION_PHRASE, LiveModeService } from '../services/LiveModeService';
import { AuthService } from '../services/AuthService';
import { audit } from '../services/AuditService';
import { AuditLogModel } from '../models/AuditLog';
import { SystemEventModel } from '../models/SystemEvent';
import { tradingEngine } from '../execution/TradingEngine';
import { tradingState } from '../services/TradingState';
import { isLiveTradingEnabledByEnv } from '../config/env';
import { AppError } from '../utils/errors';

export const systemSchemas = {
  protected: z.object({ totp: z.string().optional(), reason: z.string().max(300).optional() }),
  enableLive: z.object({ totp: z.string().optional(), password: z.string().min(1), confirmation: z.string() }),
};

export const systemController = {
  async health(_req: Request, res: Response) {
    res.json(await systemHealth());
  },

  async stopNewTrades(req: Request, res: Response) {
    const s = await EmergencyService.stopNewTrades(req.user!.email, req.body.reason);
    await audit(req, { action: 'EMERGENCY_STOP_NEW_TRADES', details: { reason: req.body.reason } });
    res.json({ state: s });
  },
  async resume(req: Request, res: Response) {
    const s = await EmergencyService.resumeTrading(req.user!.email);
    if (!tradingEngine.isRunning) tradingEngine.start();
    await audit(req, { action: 'TRADING_RESUMED' });
    res.json({ state: s });
  },
  async cancelOrders(req: Request, res: Response) {
    const r = await EmergencyService.cancelOpenOrders(req.user!.email);
    await audit(req, { action: 'EMERGENCY_CANCEL_ORDERS', details: r });
    res.json(r);
  },
  async closePositions(req: Request, res: Response) {
    const r = await EmergencyService.closeAllPositions(req.user!.email);
    await audit(req, { action: 'EMERGENCY_CLOSE_POSITIONS', details: r });
    res.json(r);
  },
  async shutdown(req: Request, res: Response) {
    const r = await EmergencyService.emergencyShutdown(req.user!.email, req.body.reason);
    await audit(req, { action: 'EMERGENCY_SHUTDOWN', details: { reason: req.body.reason } });
    res.json(r);
  },
  async clearShutdown(req: Request, res: Response) {
    const s = await EmergencyService.clearEmergency(req.user!.email);
    await audit(req, { action: 'EMERGENCY_CLEARED' });
    res.json({ state: s });
  },

  liveStatus(_req: Request, res: Response) {
    const s = tradingState.get();
    res.json({ mode: s.mode, liveModeActive: s.liveModeActive, liveTradingEnabledByEnv: isLiveTradingEnabledByEnv(), lastPreflight: LiveModeService.getLastPreflight(), confirmationPhrase: LIVE_CONFIRMATION_PHRASE });
  },
  async preflight(req: Request, res: Response) {
    const r = await LiveModeService.preflight();
    await audit(req, { action: 'LIVE_PREFLIGHT', success: r.passed, details: { checks: r.checks.map((c) => ({ name: c.name, passed: c.passed })) } });
    res.json(r);
  },
  async enableLive(req: Request, res: Response) {
    if (!(await AuthService.verifyPassword(req.user!.id, req.body.password))) {
      await audit(req, { action: 'LIVE_ENABLE_DENIED', success: false, details: { reason: 'bad password' } });
      throw new AppError(401, 'Password incorrect', 'INVALID_CREDENTIALS');
    }
    try {
      const s = await LiveModeService.activate(req.user!.id, req.body.confirmation);
      await audit(req, { action: 'LIVE_MODE_ENABLED' });
      res.json({ state: s });
    } catch (err) {
      await audit(req, { action: 'LIVE_ENABLE_DENIED', success: false, details: { reason: (err as Error).message } });
      throw err;
    }
  },
  async disableLive(req: Request, res: Response) {
    const s = await LiveModeService.deactivate(`Disabled by ${req.user!.email}`);
    await audit(req, { action: 'LIVE_MODE_DISABLED' });
    res.json({ state: s });
  },

  async auditLogs(req: Request, res: Response) {
    const q: Record<string, unknown> = {};
    if (req.query.action) q.action = String(req.query.action);
    res.json({ logs: await AuditLogModel.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit ?? 100), 500)).lean() });
  },
  async events(req: Request, res: Response) {
    const q: Record<string, unknown> = {};
    if (req.query.level) q.level = String(req.query.level);
    res.json({ events: await SystemEventModel.find(q).sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit ?? 100), 500)).lean() });
  },
};
