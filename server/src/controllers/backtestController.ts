import type { Request, Response } from 'express';
import { z } from 'zod';
import { BacktestModel } from '../models/Backtest';
import { BacktestRunModel } from '../models/BacktestRun';
import { CandleStore } from '../marketData/CandleStore';
import { BacktestEngine } from '../backtesting/BacktestEngine';
import { WalkForwardAnalyzer } from '../backtesting/WalkForward';
import { createStrategy, listStrategyKeys } from '../strategies/registry';
import { exchangeRegistry } from '../exchanges/registry';
import { validateCandles } from '../marketData/candleUtils';
import { TIMEFRAMES, TIMEFRAME_MS, type Timeframe } from '../types';
import { AppError } from '../utils/errors';
import { errorMessage, logger } from '../utils/logger';
import { audit } from '../services/AuditService';
import { env } from '../config/env';

const MAX_CANDLES = 50_000;

export const backtestSchemas = {
  create: z.object({
    name: z.string().max(100).optional(),
    strategyKey: z.string().refine((k) => listStrategyKeys().includes(k) && k !== 'arbitrage', 'Unknown/unsupported strategy'),
    params: z.record(z.string(), z.number()).default({}),
    symbol: z.string().regex(/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/),
    timeframe: z.enum(TIMEFRAMES),
    from: z.number().int().optional(),
    to: z.number().int().optional(),
    type: z.enum(['SIMPLE', 'WALK_FORWARD']).default('SIMPLE'),
    config: z
      .object({
        startingBalance: z.number().positive().max(1e9).default(10_000),
        feeRate: z.number().min(0).max(0.01).default(0.001),
        slippagePct: z.number().min(0).max(0.02).default(0.0005),
        spreadPct: z.number().min(0).max(0.02).default(0.0005),
        allowShort: z.boolean().default(false),
        trainBars: z.number().int().min(100).max(20_000).default(1000),
        validationBars: z.number().int().min(50).max(10_000).default(300),
        testBars: z.number().int().min(50).max(10_000).default(300),
        paramGrid: z.record(z.string(), z.array(z.number()).max(10)).default({}),
        minTrainTrades: z.number().int().min(1).max(1000).default(10),
      })
      .default({} as never),
  }),
  importCandles: z.object({ symbol: z.string().regex(/^[A-Z0-9]{2,15}\/[A-Z0-9]{2,15}$/), timeframe: z.enum(TIMEFRAMES), days: z.number().int().min(1).max(1095) }),
};

async function execute(btId: string) {
  const bt = await BacktestModel.findById(btId);
  if (!bt) return;
  const cfg = bt.config as z.infer<typeof backtestSchemas.create>['config'];
  const candles = await CandleStore.range(bt.exchange, bt.symbol, bt.timeframe, bt.from ?? undefined, bt.to ?? undefined, MAX_CANDLES);
  const btCfg = { timeframe: bt.timeframe as Timeframe, startingBalance: cfg.startingBalance, feeRate: cfg.feeRate, slippagePct: cfg.slippagePct, spreadPct: cfg.spreadPct, lookbackWindow: 300, risk: { allowShort: cfg.allowShort } };
  if (bt.type === 'SIMPLE') {
    const run = await BacktestRunModel.create({ backtest: bt._id, strategyKey: bt.strategyKey, segment: 'FULL', status: 'RUNNING', params: bt.params, startedAt: new Date() });
    try {
      if (candles.length < 200) throw new Error(`Only ${candles.length} candles in DB for ${bt.symbol} ${bt.timeframe}; import history first`);
      const r = new BacktestEngine().run(createStrategy(bt.strategyKey, bt.params as Record<string, number>), candles, btCfg);
      Object.assign(run, { status: 'COMPLETED', metrics: r.metrics, trades: r.trades.slice(-2000), equityCurve: downsample(r.equityCurve, 1500), warnings: r.warnings, candles: r.candles, from: r.from, to: r.to, finishedAt: new Date() });
    } catch (err) {
      Object.assign(run, { status: 'FAILED', error: errorMessage(err), finishedAt: new Date() });
    }
    await run.save();
    return;
  }
  try {
    const wf = new WalkForwardAnalyzer().run(bt.strategyKey, candles, { trainBars: cfg.trainBars, validationBars: cfg.validationBars, testBars: cfg.testBars, paramGrid: cfg.paramGrid, minTrainTrades: cfg.minTrainTrades, topK: 3, maxCombinations: 50 }, btCfg);
    for (const w of wf.windows) {
      for (const [segment, m, range] of [['TRAIN', w.train, w.trainRange], ['VALIDATION', w.validation, w.validationRange]] as const) {
        if (m) await BacktestRunModel.create({ backtest: bt._id, strategyKey: bt.strategyKey, segment, window: w.window, status: 'COMPLETED', params: w.selectedParams, metrics: m, from: range[0], to: range[1], finishedAt: new Date() });
      }
    }
    const oosTrades = wf.windows.flatMap((w) => w.oosTrades);
    await BacktestRunModel.create({
      backtest: bt._id,
      strategyKey: bt.strategyKey,
      segment: 'OUT_OF_SAMPLE',
      status: wf.windows.length ? 'COMPLETED' : 'FAILED',
      metrics: wf.outOfSampleMetrics,
      trades: oosTrades.slice(-2000),
      warnings: wf.warnings,
      params: { windows: wf.windows.map((w) => ({ window: w.window, params: w.selectedParams, testRange: w.testRange })) },
      candles: candles.length,
      finishedAt: new Date(),
      error: wf.windows.length ? undefined : wf.warnings.join('; '),
    });
  } catch (err) {
    await BacktestRunModel.create({ backtest: bt._id, strategyKey: bt.strategyKey, segment: 'OUT_OF_SAMPLE', status: 'FAILED', error: errorMessage(err), finishedAt: new Date() });
  }
}

function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const step = xs.length / max;
  return Array.from({ length: max }, (_, i) => xs[Math.floor(i * step)]).concat([xs[xs.length - 1]]);
}

export const backtestController = {
  async create(req: Request, res: Response) {
    const b = req.body as z.infer<typeof backtestSchemas.create>;
    const bt = await BacktestModel.create({ ...b, user: req.user!.id, exchange: env.DEFAULT_EXCHANGE });
    await audit(req, { action: 'BACKTEST_STARTED', resource: 'backtest', resourceId: bt._id.toString(), details: { strategy: b.strategyKey, symbol: b.symbol, type: b.type } });
    setImmediate(() => void execute(bt._id.toString()).catch((err) => logger.error({ err: errorMessage(err) }, 'Backtest crashed')));
    res.status(202).json({ backtest: bt });
  },

  async list(_req: Request, res: Response) {
    const bts = await BacktestModel.find().sort({ createdAt: -1 }).limit(100).lean();
    const runs = await BacktestRunModel.find({ backtest: { $in: bts.map((b) => b._id) } }).select({ trades: 0, equityCurve: 0 }).lean();
    res.json({ backtests: bts.map((b) => ({ ...b, runs: runs.filter((r) => String(r.backtest) === String(b._id)) })) });
  },

  async get(req: Request, res: Response) {
    const bt = await BacktestModel.findById(req.params.id).lean();
    if (!bt) throw new AppError(404, 'Backtest not found');
    res.json({ backtest: bt, runs: await BacktestRunModel.find({ backtest: bt._id }).sort({ segment: 1, window: 1 }).lean() });
  },

  /** Import historical candles from the exchange's public API into MongoDB. */
  async importCandles(req: Request, res: Response) {
    const { symbol, timeframe, days } = req.body as z.infer<typeof backtestSchemas.importCandles>;
    const adapter = exchangeRegistry.public(env.DEFAULT_EXCHANGE);
    const step = TIMEFRAME_MS[timeframe];
    let since = Date.now() - days * 86_400_000;
    let total = 0;
    for (let guard = 0; guard < 2000 && since < Date.now() - step; guard++) {
      const batch = await adapter.getCandles(symbol, timeframe, since, 1000);
      if (!batch.length) break;
      const { valid } = validateCandles(batch, timeframe);
      const r = await CandleStore.upsertMany(env.DEFAULT_EXCHANGE, symbol, timeframe, valid, 'IMPORT');
      total += r.upserted;
      const next = batch[batch.length - 1].timestamp + step;
      if (next <= since) break;
      since = next;
    }
    await audit(req, { action: 'CANDLES_IMPORTED', details: { symbol, timeframe, days, inserted: total } });
    res.json({ symbol, timeframe, inserted: total });
  },
};
