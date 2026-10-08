import { randomUUID } from 'crypto';
import { exchangeRegistry, SUPPORTED_EXCHANGES } from '../exchanges/registry';
import { ArbitrageStrategy, type VenueQuote } from '../strategies/ArbitrageStrategy';
import { StrategyModel } from '../models/Strategy';
import { SignalModel } from '../models/Signal';
import { orderExecutionService } from '../execution/OrderExecutionService';
import { circuitBreaker } from '../risk/CircuitBreaker';
import { marketDataCache } from '../marketData/MarketDataCache';
import { tradingState } from './TradingState';
import { eventBus } from '../utils/eventBus';
import { errorMessage, logger } from '../utils/logger';

/**
 * Optional cross-exchange arbitrage. Quotes come from order books (never last prices); an
 * opportunity is executed only if expected NET profit after fees, slippage, latency, liquidity,
 * funding and transfer costs exceeds the configured minimum. Requires pre-funded balances on
 * both venues (no transfers - the platform never moves funds between exchanges).
 */
export class ArbitrageService {
  lastOpportunities: unknown[] = [];

  async scan() {
    const doc = await StrategyModel.findOne({ key: 'arbitrage' });
    const mode = tradingState.get().mode;
    const allowed = mode === 'PAPER' ? ['PAPER', 'APPROVED', 'LIVE'] : ['LIVE'];
    if (!doc?.enabled || !allowed.includes(doc.stage)) return;
    const strat = new ArbitrageStrategy({ ...(doc.params as Record<string, number>), minNetProfitPct: tradingState.get().arbitrageMinNetProfitPct });
    const venues = SUPPORTED_EXCHANGES.slice();
    for (const symbol of doc.symbols) {
      const quotes: VenueQuote[] = [];
      for (const ex of venues) {
        try {
          const ob = await exchangeRegistry.public(ex).getOrderBook(symbol, 10);
          marketDataCache.setOrderBook(ex, ob);
          if (!ob.bids[0] || !ob.asks[0]) continue;
          quotes.push({ exchange: ex, bid: ob.bids[0].price, ask: ob.asks[0].price, bidSize: ob.bids[0].amount, askSize: ob.asks[0].amount, takerFee: 0.001, timestamp: ob.timestamp });
        } catch (err) {
          logger.debug({ ex, symbol, err: errorMessage(err) }, 'Arbitrage quote failed');
        }
      }
      if (quotes.length < 2) continue;
      const opp = strat.evaluateOpportunity(quotes, { slippagePct: 0.0005, transferCost: 0, latencyPct: 0.0003, fundingPct: 0, maxQuoteAgeMs: 3000 });
      if (!opp) continue;
      this.lastOpportunities = [{ symbol, ...opp, at: new Date().toISOString() }];
      eventBus.publish('signal', { kind: 'arbitrage', symbol, ...opp });
      if (!opp.executable || !tradingState.get().tradingEnabled || !circuitBreaker.canOpenNewPositions()) continue;

      const signal = await SignalModel.create({ mode, strategyKey: 'arbitrage', symbol, action: 'LONG', confidence: 1, price: opp.buyPrice, reason: `Buy ${opp.buyExchange} @ ${opp.buyPrice}, sell ${opp.sellExchange} @ ${opp.sellPrice}; net ${opp.expectedNetProfit.toFixed(4)}`, decision: 'EXECUTE', candleTimestamp: Date.now() });
      const id = randomUUID();
      // Both legs submitted concurrently to minimise legging risk.
      await Promise.allSettled([
        orderExecutionService.submit({ mode, exchange: opp.buyExchange, symbol, side: 'buy', type: 'limit', price: opp.buyPrice, amount: opp.amount, idempotencyKey: `arb:${id}:buy`, purpose: 'ENTRY', strategyKey: 'arbitrage', signal: signal._id }),
        orderExecutionService.submit({ mode, exchange: opp.sellExchange, symbol, side: 'sell', type: 'limit', price: opp.sellPrice, amount: opp.amount, idempotencyKey: `arb:${id}:sell`, purpose: 'ENTRY', strategyKey: 'arbitrage', signal: signal._id }),
      ]);
    }
  }
}

export const arbitrageService = new ArbitrageService();
