import { randomUUID } from 'crypto';
import { exchangeRegistry, SUPPORTED_EXCHANGES } from '../exchanges/registry';
import { ArbitrageStrategy, type ArbitrageOpportunity, type VenueQuote } from '../strategies/ArbitrageStrategy';
import { StrategyModel } from '../models/Strategy';
import { SignalModel } from '../models/Signal';
import { TradeModel } from '../models/Trade';
import { PortfolioModel } from '../models/Portfolio';
import { RiskEventModel } from '../models/RiskEvent';
import { orderExecutionService, type OrderExecutionService } from '../execution/OrderExecutionService';
import { circuitBreaker } from '../risk/CircuitBreaker';
import { marketDataCache } from '../marketData/MarketDataCache';
import { portfolioService } from '../portfolio/PortfolioService';
import { notificationService } from '../notifications/NotificationService';
import { tradingState } from './TradingState';
import { eventBus } from '../utils/eventBus';
import { errorMessage, logger } from '../utils/logger';

type Mode = 'PAPER' | 'LIVE';
type OrderDoc = Awaited<ReturnType<OrderExecutionService['submit']>>;
const TERMINAL = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'];

export interface ArbitrageExecution {
  status: 'COMPLETED' | 'NOT_FILLED' | 'UNHEDGED';
  hedgedAmount: number;
  netPnl: number;
  fees: number;
  tradeId?: string;
  detail: string;
}

/**
 * Optional cross-exchange arbitrage. Quotes come from order books (never last prices); an
 * opportunity is executed only if expected NET profit after fees, slippage, latency, liquidity,
 * funding and transfer costs exceeds the configured minimum. Requires pre-funded balances on
 * both venues (no transfers - the platform never moves funds between exchanges).
 *
 * Execution: both legs are sent concurrently as limit orders at the quoted prices with IOC
 * semantics (any unfilled remainder is cancelled immediately). The hedged quantity
 * (min of both fills) is booked as one Trade and its net P&L is applied to the portfolio.
 * A fill mismatch leaves unhedged exposure: it is recorded, the breaker trips (manual reset),
 * and the arbitrage strategy is disabled until a human reviews it.
 */
export class ArbitrageService {
  lastOpportunities: unknown[] = [];

  constructor(private exec: OrderExecutionService = orderExecutionService) {}

  async scan() {
    const doc = await StrategyModel.findOne({ key: 'arbitrage' });
    const mode = tradingState.get().mode;
    const allowed = mode === 'PAPER' ? ['PAPER', 'APPROVED', 'LIVE'] : ['LIVE'];
    if (!doc?.enabled || !allowed.includes(doc.stage)) return;
    const strat = new ArbitrageStrategy({ ...(doc.params as Record<string, number>), minNetProfitPct: tradingState.get().arbitrageMinNetProfitPct });
    for (const symbol of doc.symbols) {
      const quotes: VenueQuote[] = [];
      for (const ex of SUPPORTED_EXCHANGES) {
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
      const signal = await SignalModel.create({ mode, strategyKey: 'arbitrage', symbol, action: 'LONG', confidence: 1, price: opp.buyPrice, reason: `Buy ${opp.buyExchange} @ ${opp.buyPrice}, sell ${opp.sellExchange} @ ${opp.sellPrice}; expected net ${opp.expectedNetProfit.toFixed(4)}`, decision: 'EXECUTE', candleTimestamp: Date.now() });
      await this.execute(mode, symbol, opp, signal._id.toString());
    }
  }

  async execute(mode: Mode, symbol: string, opp: ArbitrageOpportunity, signalId?: string): Promise<ArbitrageExecution> {
    const id = randomUUID();
    const common = { mode, symbol, type: 'limit' as const, amount: opp.amount, purpose: 'ENTRY' as const, strategyKey: 'arbitrage', signal: signalId };
    const [b, s] = await Promise.allSettled([
      this.exec.submit({ ...common, exchange: opp.buyExchange, side: 'buy', price: opp.buyPrice, idempotencyKey: `arb:${id}:buy` }),
      this.exec.submit({ ...common, exchange: opp.sellExchange, side: 'sell', price: opp.sellPrice, idempotencyKey: `arb:${id}:sell` }),
    ]);
    const legs = [b, s].map((r) => (r.status === 'fulfilled' ? r.value : null));
    // IOC: never leave arbitrage legs resting on the book.
    for (const leg of legs) {
      if (leg && !TERMINAL.includes(leg.status)) await this.exec.cancel(leg._id.toString()).catch((err) => logger.error({ err: errorMessage(err) }, 'Arbitrage leg cancel failed'));
    }
    const [buy, sell] = legs as [OrderDoc | null, OrderDoc | null];
    const buyQty = buy?.filled ?? 0;
    const sellQty = sell?.filled ?? 0;
    const hedged = Math.min(buyQty, sellQty);
    const residual = buyQty - sellQty;

    let result: ArbitrageExecution = { status: 'NOT_FILLED', hedgedAmount: 0, netPnl: 0, fees: 0, detail: 'Neither leg filled' };
    if (hedged > 0 && buy?.averagePrice && sell?.averagePrice) {
      // Pro-rate fees to the hedged quantity; any residual is handled below as unhedged exposure.
      const fees = (buy.fee ?? 0) * (hedged / buyQty) + (sell.fee ?? 0) * (hedged / sellQty);
      const gross = (sell.averagePrice - buy.averagePrice) * hedged;
      const net = gross - fees;
      await portfolioService.get(mode);
      // Pre-funded venues: cash moves by the realized spread less fees; inventory is unchanged net.
      await PortfolioModel.updateOne({ mode }, { $inc: { balance: net, realizedPnl: net, fees } });
      const trade = await TradeModel.create({
        mode,
        exchange: `${opp.buyExchange}->${opp.sellExchange}`,
        symbol,
        direction: 'LONG',
        strategyKey: 'arbitrage',
        amount: hedged,
        entryPrice: buy.averagePrice,
        exitPrice: sell.averagePrice,
        grossPnl: gross,
        fees,
        slippage: Math.abs(buy.averagePrice - opp.buyPrice) * hedged + Math.abs(opp.sellPrice - sell.averagePrice) * hedged,
        netPnl: net,
        returnPct: net / (buy.averagePrice * hedged),
        exitReason: `Arbitrage ${opp.buyExchange} -> ${opp.sellExchange}`,
        signal: signalId,
        entryOrder: buy._id,
        exitOrder: sell._id,
        openedAt: buy.createdAt,
        closedAt: new Date(),
      });
      eventBus.publish('trade', trade.toJSON());
      result = { status: 'COMPLETED', hedgedAmount: hedged, netPnl: net, fees, tradeId: trade._id.toString(), detail: `Hedged ${hedged} ${symbol}` };
      void portfolioService.revalue(mode).catch(() => undefined);
    }

    if (Math.abs(residual) > 1e-12) {
      const detail = `${symbol}: bought ${buyQty} on ${opp.buyExchange}, sold ${sellQty} on ${opp.sellExchange}; unhedged ${residual > 0 ? 'long' : 'short'} ${Math.abs(residual)}`;
      circuitBreaker.trip('UNHEDGED_EXPOSURE', detail);
      await StrategyModel.updateOne({ key: 'arbitrage' }, { $set: { enabled: false, disabledReason: `Unhedged exposure: ${detail}` } });
      await RiskEventModel.create({ type: 'ARBITRAGE_UNHEDGED', severity: 'CRITICAL', mode, symbol, strategyKey: 'arbitrage', message: detail, details: { buyOrder: buy?._id, sellOrder: sell?._id } });
      void notificationService.notify('STRATEGY_DISABLED', 'Arbitrage legged - strategy disabled', `${detail}. Rebalance manually, then reset UNHEDGED_EXPOSURE.`);
      result = { ...result, status: 'UNHEDGED', detail };
    }
    return result;
  }
}

export const arbitrageService = new ArbitrageService();
