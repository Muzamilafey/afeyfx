import type { Request, Response } from 'express';
import { z } from 'zod';
import { StrategyModel, STRATEGY_STAGES } from '../models/Strategy';
import { StrategyVersion } from '../models/StrategyVersion';
import { BacktestRunModel } from '../models/BacktestRun';
import { TradeModel } from '../models/Trade';
import { createStrategy, listStrategyKeys } from '../strategies/registry';
import { audit } from '../services/AuditService';
import { notificationService } from '../notifications/NotificationService';
import { AppError } from '../utils/errors';
import { TIMEFRAMES } from '../types';

const REGIMES = ['TRENDING_UP', 'TRENDING_DOWN', 'SIDEWAYS', 'HIGH_VOLATILITY', 'LOW_VOLATILITY', 'ABNORMAL'] as const;

export const strategySchemas = {
  update: z.object({
    enabled: z.boolean().optional(),
    symbols: z.array(z.string().regex(/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/)).max(20).optional(),
    timeframes: z.array(z.enum(TIMEFRAMES)).max(8).optional(),
    params: z.record(z.string(), z.number()).optional(),
    allowedRegimes: z.array(z.enum(REGIMES)).optional(),
    requireAiConfirmation: z.boolean().optional(),
    totp: z.string().optional(),
  }),
  stage: z.object({ stage: z.enum(STRATEGY_STAGES), totp: z.string().optional(), note: z.string().max(500).optional() }),
  review: z.object({ decision: z.enum(['APPROVED', 'REJECTED']), totp: z.string().optional() }),
};

const MIN_EVIDENCE_TRADES = 5;

/** Allowed promotions. Each step requires evidence; LIVE requires prior human APPROVAL. */
const NEXT: Record<string, string[]> = {
  RESEARCH: ['BACKTEST', 'RETIRED'],
  BACKTEST: ['OUT_OF_SAMPLE', 'RESEARCH', 'RETIRED'],
  OUT_OF_SAMPLE: ['PAPER', 'BACKTEST', 'RETIRED'],
  PAPER: ['APPROVED', 'OUT_OF_SAMPLE', 'RETIRED'],
  APPROVED: ['LIVE', 'PAPER', 'RETIRED'],
  LIVE: ['PAPER', 'RETIRED'],
  RETIRED: ['RESEARCH'],
};

/** Seed DB documents for every registry strategy (disabled, RESEARCH stage). */
export async function seedStrategies(symbols: string[]) {
  for (const key of listStrategyKeys()) {
    const s = createStrategy(key);
    await StrategyModel.updateOne(
      { key },
      { $setOnInsert: { key, name: s.name, version: s.version, description: s.description, enabled: false, stage: 'RESEARCH', symbols, timeframes: s.timeframes, riskLevel: s.riskLevel, params: s.params, allowedRegimes: s.allowedRegimes, requireAiConfirmation: true } },
      { upsert: true },
    );
  }
}

export const strategyController = {
  async list(_req: Request, res: Response) {
    const docs = await StrategyModel.find().sort({ key: 1 }).lean();
    const out = docs.map((d) => {
      const s = createStrategy(d.key, d.params as Record<string, number>);
      return { ...d, requiredIndicators: s.requiredIndicators, defaultAllowedRegimes: s.allowedRegimes };
    });
    res.json({ strategies: out });
  },

  async update(req: Request, res: Response) {
    const doc = await StrategyModel.findOne({ key: req.params.key });
    if (!doc) throw new AppError(404, 'Strategy not found');
    const { totp: _t, ...body } = req.body;
    if (body.params) createStrategy(doc.key, body.params); // validates key
    if (body.enabled === true && doc.stage === 'RESEARCH') throw new AppError(409, 'Strategy is in RESEARCH; backtest it before enabling');
    const before = { enabled: doc.enabled, params: doc.params };
    Object.assign(doc, body);
    if (body.params) {
      // Any parameter change creates a new version and drops a LIVE/APPROVED strategy back to PAPER.
      const v = `${doc.version.split('+')[0]}+${Date.now()}`;
      await StrategyVersion.create({ strategyKey: doc.key, version: v, params: body.params, source: 'HUMAN', status: 'PROPOSED', createdBy: req.user!.id });
      doc.version = v;
      if (doc.stage === 'LIVE' || doc.stage === 'APPROVED') doc.stage = 'PAPER';
    }
    await doc.save();
    if (body.enabled === false && before.enabled) void notificationService.notify('STRATEGY_DISABLED', `Strategy ${doc.name} disabled`, `By ${req.user!.email}`);
    await audit(req, { action: 'STRATEGY_UPDATED', resource: 'strategy', resourceId: doc.key, details: { before, after: body } });
    res.json({ strategy: doc });
  },

  async setStage(req: Request, res: Response) {
    const doc = await StrategyModel.findOne({ key: req.params.key });
    if (!doc) throw new AppError(404, 'Strategy not found');
    const to = req.body.stage as string;
    if (!NEXT[doc.stage]?.includes(to)) throw new AppError(409, `Cannot move from ${doc.stage} to ${to}`);
    if (to === 'OUT_OF_SAMPLE' || to === 'PAPER') {
      // Evidence must contain actual trades - a backtest that never traded proves nothing.
      const runs = await BacktestRunModel.countDocuments({ strategyKey: doc.key, status: 'COMPLETED', segment: to === 'PAPER' ? 'OUT_OF_SAMPLE' : { $in: ['FULL', 'TRAIN', 'OUT_OF_SAMPLE'] }, 'metrics.numberOfTrades': { $gte: MIN_EVIDENCE_TRADES } });
      if (!runs) throw new AppError(412, to === 'PAPER' ? `An out-of-sample (walk-forward) backtest with at least ${MIN_EVIDENCE_TRADES} trades is required before paper trading` : `A completed backtest with at least ${MIN_EVIDENCE_TRADES} trades is required`);
    }
    if (to === 'APPROVED') {
      const paperTrades = await TradeModel.countDocuments({ mode: 'PAPER', strategyKey: doc.key, user: null });
      if (paperTrades < 30) throw new AppError(412, `At least 30 paper trades required before approval (have ${paperTrades})`);
      doc.approvedBy = req.user!.id as never;
      doc.approvedAt = new Date();
    }
    if (to === 'LIVE' && doc.stage !== 'APPROVED') throw new AppError(412, 'Strategy must be APPROVED by a human first');
    const from = doc.stage;
    doc.stage = to as never;
    if (to === 'RETIRED') doc.enabled = false;
    await doc.save();
    await audit(req, { action: 'STRATEGY_STAGE_CHANGED', resource: 'strategy', resourceId: doc.key, details: { from, to, note: req.body.note } });
    res.json({ strategy: doc });
  },

  async versions(req: Request, res: Response) {
    res.json({ versions: await StrategyVersion.find({ strategyKey: req.params.key }).sort({ createdAt: -1 }).limit(100).lean() });
  },

  async reviewVersion(req: Request, res: Response) {
    const v = await StrategyVersion.findOne({ _id: req.params.id, strategyKey: req.params.key });
    if (!v) throw new AppError(404, 'Version not found');
    v.status = req.body.decision;
    v.reviewedBy = req.user!.id as never;
    v.reviewedAt = new Date();
    await v.save();
    await audit(req, { action: 'STRATEGY_VERSION_REVIEWED', resource: 'strategyVersion', resourceId: v._id.toString(), details: { decision: req.body.decision, source: v.source } });
    res.json({ version: v, note: 'Approving a version does not deploy it. Apply its params via the strategy settings; the strategy will return to PAPER stage.' });
  },
};
