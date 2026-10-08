import type { Request, Response } from 'express';
import { portfolioService } from '../portfolio/PortfolioService';
import { PortfolioSnapshot } from '../models/PortfolioSnapshot';
import { BacktestRunModel } from '../models/BacktestRun';
import { TradeModel } from '../models/Trade';
import { computeMetrics } from '../portfolio/metrics';
import { tradingState } from '../services/TradingState';

const modeOf = (q: unknown) => (q === 'LIVE' ? 'LIVE' : q === 'PAPER' ? 'PAPER' : tradingState.get().mode);

export const portfolioController = {
  async get(req: Request, res: Response) {
    const mode = modeOf(req.query.mode);
    const p = await portfolioService.revalue(mode);
    res.json({ portfolio: portfolioService.view(p) });
  },

  async performance(req: Request, res: Response) {
    const mode = modeOf(req.query.mode);
    const g = ['strategyKey', 'symbol', 'timeframe'].includes(String(req.query.groupBy)) ? (String(req.query.groupBy) as 'strategyKey' | 'symbol' | 'timeframe') : undefined;
    res.json({ mode, ...(await portfolioService.performance(mode, g)) });
  },

  async snapshots(req: Request, res: Response) {
    const mode = modeOf(req.query.mode);
    const since = new Date(Date.now() - Math.min(Number(req.query.days ?? 30), 365) * 86_400_000);
    res.json({ snapshots: await PortfolioSnapshot.find({ mode, timestamp: { $gte: since } }).sort({ timestamp: 1 }).limit(10_000).lean() });
  },

  /**
   * Profitability report: backtest, out-of-sample, paper and live performance reported SEPARATELY
   * per strategy. Nothing is blended; a strategy is never called profitable from one backtest.
   */
  async report(_req: Request, res: Response) {
    const keys = await TradeModel.distinct('strategyKey');
    const btKeys = await BacktestRunModel.distinct('strategyKey');
    const all = [...new Set([...keys, ...btKeys].filter(Boolean))] as string[];
    const out = [];
    for (const key of all) {
      const latest = async (segment: 'FULL' | 'OUT_OF_SAMPLE') => (await BacktestRunModel.findOne({ strategyKey: key, segment, status: 'COMPLETED' }).sort({ finishedAt: -1 }).select({ metrics: 1, finishedAt: 1, warnings: 1 }).lean()) ?? null;
      const mode = async (m: 'PAPER' | 'LIVE') => {
        const ts = await TradeModel.find({ mode: m, strategyKey: key }).sort({ closedAt: 1 }).lean();
        if (!ts.length) return null;
        let eq = 10_000;
        const curve = [{ t: 0, equity: eq }, ...ts.map((t) => ({ t: new Date(t.closedAt ?? 0).getTime(), equity: (eq += t.netPnl ?? 0) }))];
        return computeMetrics(ts.map((t) => ({ netPnl: t.netPnl ?? 0, fees: t.fees ?? 0, slippage: t.slippage ?? 0 })), curve, 10_000, 365);
      };
      out.push({ strategyKey: key, backtest: await latest('FULL'), outOfSample: await latest('OUT_OF_SAMPLE'), paper: await mode('PAPER'), live: await mode('LIVE') });
    }
    res.json({
      disclaimer: 'Past performance (backtest, paper or live) does not guarantee future results. Metrics include fees and slippage; losing trades are never excluded.',
      strategies: out,
    });
  },
};
