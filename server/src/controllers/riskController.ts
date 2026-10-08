import type { Request, Response } from 'express';
import { z } from 'zod';
import { circuitBreaker, type TripCode } from '../risk/CircuitBreaker';
import { RiskEventModel } from '../models/RiskEvent';
import { PositionModel } from '../models/Position';
import { portfolioService } from '../portfolio/PortfolioService';
import { SettingsService } from '../services/SettingsService';
import { tradingState } from '../services/TradingState';
import { audit } from '../services/AuditService';

export const riskSchemas = {
  config: z.object({
    maxRiskPerTrade: z.number().optional(),
    maxDailyLoss: z.number().optional(),
    maxWeeklyLoss: z.number().optional(),
    maxOpenPositions: z.number().int().optional(),
    maxPortfolioExposure: z.number().optional(),
    maxLeverage: z.number().optional(),
    maxSpreadPct: z.number().optional(),
    maxSlippagePct: z.number().optional(),
    maxCorrelatedPositions: z.number().int().optional(),
    correlationThreshold: z.number().optional(),
    minRewardRisk: z.number().optional(),
    minExpectedProfitPct: z.number().optional(),
    maxBookParticipation: z.number().optional(),
    allowShort: z.boolean().optional(),
    totp: z.string().optional(),
  }),
  reset: z.object({ code: z.string().min(3).max(50), totp: z.string().optional() }),
};

export const riskController = {
  async status(_req: Request, res: Response) {
    const s = tradingState.get();
    const p = portfolioService.view(await portfolioService.revalue(s.mode));
    const open = await PositionModel.countDocuments({ mode: s.mode, status: 'OPEN', user: null });
    res.json({
      mode: s.mode,
      config: s.risk,
      circuitBreaker: circuitBreaker.status(),
      tradingEnabled: s.tradingEnabled,
      emergencyShutdown: s.emergencyShutdown,
      exposure: { value: p.exposure, pct: p.exposurePct, max: s.risk.maxPortfolioExposure },
      dailyLoss: { pct: p.dailyDrawdownPct, max: s.risk.maxDailyLoss, pnl: p.dailyPnl },
      weeklyLoss: { pct: p.weeklyDrawdownPct, max: s.risk.maxWeeklyLoss },
      openPositions: { count: open, max: s.risk.maxOpenPositions },
      riskPerTrade: s.risk.maxRiskPerTrade,
    });
  },

  async updateConfig(req: Request, res: Response) {
    const { totp: _t, ...body } = req.body;
    const before = tradingState.get().risk;
    const after = await SettingsService.updateRisk(body);
    await audit(req, { action: 'RISK_CONFIG_UPDATED', details: { before, after: body } });
    res.json({ config: after });
  },

  async resetBreaker(req: Request, res: Response) {
    const code = req.body.code as TripCode | 'ALL';
    if (code === 'ALL') circuitBreaker.resetAll();
    else circuitBreaker.reset(code);
    await RiskEventModel.create({ type: 'CIRCUIT_BREAKER_RESET', severity: 'WARNING', message: `${code} reset by ${req.user!.email}` });
    await audit(req, { action: 'CIRCUIT_BREAKER_RESET', details: { code } });
    res.json({ circuitBreaker: circuitBreaker.status() });
  },

  async events(req: Request, res: Response) {
    res.json({ events: await RiskEventModel.find().sort({ createdAt: -1 }).limit(Math.min(Number(req.query.limit ?? 100), 500)).lean() });
  },
};
