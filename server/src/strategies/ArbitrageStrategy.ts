import type { MarketRegime, SignalAction } from '../types';
import type { IndicatorName } from '../services/analysis/TechnicalAnalysisService';
import { BaseStrategy, type MarketAnalysis, type StrategyContext } from './Strategy';

export interface VenueQuote {
  exchange: string;
  bid: number;
  ask: number;
  bidSize: number; // base units available at best bid
  askSize: number; // base units available at best ask
  takerFee: number; // fraction
  timestamp: number;
  fundingRate?: number;
}

export interface ArbitrageCosts {
  /** Expected slippage fraction per leg. */
  slippagePct: number;
  /** Fixed transfer/rebalancing cost in quote currency per round trip (0 if pre-funded on both venues). */
  transferCost: number;
  /** Price drift allowance due to latency, as a fraction. */
  latencyPct: number;
  /** Funding cost fraction for holding period (perps), if applicable. */
  fundingPct: number;
  /** Max acceptable quote age (ms). */
  maxQuoteAgeMs: number;
}

export interface ArbitrageOpportunity {
  buyExchange: string;
  sellExchange: string;
  buyPrice: number;
  sellPrice: number;
  amount: number;
  grossSpreadPct: number;
  grossProfit: number;
  totalCosts: number;
  expectedNetProfit: number;
  expectedNetProfitPct: number;
  executable: boolean;
  reasons: string[];
}

/**
 * Cross-exchange arbitrage evaluator. Executes ONLY when expected net profit after fees, spread
 * (bid/ask used directly), slippage, latency, liquidity, funding and transfer costs exceeds the
 * minimum required profit. Never trades on displayed last-price differences.
 */
export class ArbitrageStrategy extends BaseStrategy {
  id = 'arbitrage';
  name = 'Arbitrage';
  version = '1.0.0';
  description = 'Cross-exchange spread capture, executed only when net expected profit > minimum after all costs.';
  allowedRegimes: MarketRegime[] = ['TRENDING_UP', 'TRENDING_DOWN', 'SIDEWAYS', 'LOW_VOLATILITY', 'HIGH_VOLATILITY'];
  requiredIndicators: IndicatorName[] = [];
  riskLevel = 'HIGH' as const;

  constructor(overrides: Record<string, number> = {}) {
    super({ minNetProfitPct: 0.002, maxNotional: 1000 }, overrides);
  }

  protected entryLogic(_ctx: StrategyContext, _a: MarketAnalysis): { action: SignalAction; confidence: number; reason: string } {
    return { action: 'HOLD', confidence: 0, reason: 'Arbitrage uses evaluateOpportunity() with multi-venue quotes' };
  }

  evaluateOpportunity(quotes: VenueQuote[], costs: ArbitrageCosts, now = Date.now()): ArbitrageOpportunity | null {
    let best: ArbitrageOpportunity | null = null;
    for (const buy of quotes) {
      for (const sell of quotes) {
        if (buy.exchange === sell.exchange) continue;
        const reasons: string[] = [];
        if (!(buy.ask > 0 && sell.bid > 0)) continue;
        if (now - buy.timestamp > costs.maxQuoteAgeMs || now - sell.timestamp > costs.maxQuoteAgeMs) reasons.push('Stale quote');
        const amount = Math.min(buy.askSize, sell.bidSize, this.params.maxNotional / buy.ask);
        if (!(amount > 0)) reasons.push('Insufficient liquidity');
        const grossSpreadPct = (sell.bid - buy.ask) / buy.ask;
        const grossProfit = (sell.bid - buy.ask) * amount;
        const buyNotional = buy.ask * amount;
        const sellNotional = sell.bid * amount;
        const fees = buyNotional * buy.takerFee + sellNotional * sell.takerFee;
        const slippage = (buyNotional + sellNotional) * costs.slippagePct;
        const latency = (buyNotional + sellNotional) * costs.latencyPct;
        const funding = buyNotional * costs.fundingPct;
        const totalCosts = fees + slippage + latency + funding + costs.transferCost;
        const expectedNetProfit = grossProfit - totalCosts;
        const expectedNetProfitPct = buyNotional > 0 ? expectedNetProfit / buyNotional : 0;
        if (!(expectedNetProfitPct > this.params.minNetProfitPct)) {
          reasons.push(`Net ${(expectedNetProfitPct * 100).toFixed(3)}% <= min ${(this.params.minNetProfitPct * 100).toFixed(3)}%`);
        }
        const opp: ArbitrageOpportunity = {
          buyExchange: buy.exchange,
          sellExchange: sell.exchange,
          buyPrice: buy.ask,
          sellPrice: sell.bid,
          amount,
          grossSpreadPct,
          grossProfit,
          totalCosts,
          expectedNetProfit,
          expectedNetProfitPct,
          executable: reasons.length === 0,
          reasons,
        };
        if (!best || opp.expectedNetProfit > best.expectedNetProfit) best = opp;
      }
    }
    return best;
  }
}
