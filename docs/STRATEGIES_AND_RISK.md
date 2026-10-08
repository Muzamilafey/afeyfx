# Strategies, AI decisions and risk

## Strategy contract

Every strategy implements `Strategy` (`server/src/strategies/Strategy.ts`):

* properties: `id`, `name`, `version`, `description`, `timeframes`, `symbols`, `riskLevel`, `allowedRegimes`,
  `requiredIndicators`, `params`
* methods: `analyzeMarket()`, `generateSignal()`, `validateEntry()`, `calculateStopLoss()`,
  `calculateTakeProfit()`, `calculatePositionSize()`, `shouldExit()`

Each strategy declares the indicators it needs, and only those are computed. `generateSignal()` returns
HOLD when there is too little data or the current regime isn't in `allowedRegimes`.

| Strategy | Logic | Allowed regimes |
|---|---|---|
| Trend Following | EMA20/50 cross + ADX ≥ 25 + DI direction; exit on reverse cross | TRENDING_UP/DOWN |
| Momentum | MACD histogram zero-cross + RSI zone + ROC sign | TRENDING_UP/DOWN |
| Mean Reversion | %B outside the bands + RSI extreme; exit at the middle band | SIDEWAYS, LOW_VOLATILITY |
| Breakout | Close beyond the prior N-bar high/low with relative volume ≥ 1.5 | SIDEWAYS, LOW_VOL, TRENDING |
| VWAP | Session (UTC day) VWAP reclaim/loss in the direction of EMA50 | TRENDING, SIDEWAYS |
| Arbitrage | Cross-exchange; executes only if **net** expected profit > minimum after fees, spread (bid/ask), slippage, latency, liquidity, funding and transfer costs. Both legs are IOC limit orders. Hedged quantity is booked as one trade into the portfolio P&L; an unhedged remainder trips the breaker and disables the strategy | any (except ABNORMAL) |

All strategies are created **disabled** at the **RESEARCH** stage. Don't enable them all at once.

### Lifecycle

`RESEARCH → BACKTEST → OUT_OF_SAMPLE → PAPER → APPROVED → LIVE` (plus `RETIRED`). The server enforces these rules:

* OUT_OF_SAMPLE needs a completed backtest with ≥ 5 trades. PAPER needs a completed walk-forward OOS run with ≥ 5 trades.
* APPROVED needs ≥ 30 paper trades and an admin with 2FA. LIVE needs APPROVED.
* Any parameter change creates a new `StrategyVersion` and sends LIVE or APPROVED back to PAPER.
* AI proposals are stored as `StrategyVersion(source=AI_PROPOSAL, status=PROPOSED)`. They are never applied automatically.

## Market regimes

`MarketRegimeService` (ADX/DI, EMA20 vs EMA50, ATR% percentile over a 200-bar window, last-bar return z-score):
ABNORMAL (bad data or a |z| ≥ 6 move) > HIGH_VOLATILITY (ATR% ≥ 90th percentile) > TRENDING_UP/DOWN (ADX ≥ 25) >
LOW_VOLATILITY (≤ 10th percentile) > SIDEWAYS. No strategy enters in ABNORMAL, and open positions exit.

## AI decision rules

A trade is EXECUTED only if **every** critical check passes (`server/src/ai/DecisionService.ts`):

| Check | Rule |
|---|---|
| strategy-signal / confidence / validation | LONG or SHORT, confidence ≥ 0.5, stop on the correct side, etc. |
| ai-agreement | AI signal == strategy direction (configurable) |
| ai-confidence | ≥ `AI_MIN_CONFIDENCE` (default 0.65) |
| ai-data-quality / ai-regime | no data-quality concerns, regime ≠ ABNORMAL |
| liquidity / spread / expected-profit | taken from the risk engine checks |
| risk-engine | approved |

If AI is **enabled** but errors or refuses, the trade is REJECTED (fail closed). If AI is **disabled** by configuration,
the AI checks are skipped and every other check still applies. AI can only veto. It can't create a trade or override risk.

## Risk engine

`RiskEngine.evaluate()` is a pure function. It fails closed on any invalid input and checks the following:
inputs valid, circuit breaker, data freshness, shorting allowed (off by default, since spot can't short), stop on
the correct side, spread, expected slippage, leverage, daily and weekly drawdown, max open positions, no duplicate
symbol, correlation with open positions, position size above the exchange minimum, portfolio exposure, max loss
≤ risk-per-trade × equity (including round-trip fees and slippage), reward:risk, and expected net profit at the target.

Position size = `equity × riskPerTrade / (stopDistance + roundTripCostPerUnit)`, rounded **down** to the exchange
precision, then capped by exposure, available cash, leverage and order-book participation (≤ 25% of the depth
within the slippage band).

Defaults: `MAX_RISK_PER_TRADE=0.005`, `MAX_DAILY_LOSS=0.02`, `MAX_WEEKLY_LOSS=0.05`, `MAX_OPEN_POSITIONS=5`,
`MAX_PORTFOLIO_EXPOSURE=0.20`, `MAX_LEVERAGE=1`. These can be changed from Admin → Risk, **within hard bounds**
(e.g. risk per trade ≤ 2%, leverage ≤ 3).

## Circuit breaker

Stops **new** positions. Exits are still allowed so you can always reduce risk.

| Trip | Source | Reset |
|---|---|---|
| DAILY_LOSS_LIMIT / WEEKLY_LOSS_LIMIT | risk-check job | human |
| STALE_MARKET_DATA | market-data health | automatic on recovery |
| EXCHANGE_DISCONNECTED | REST and WS both down | automatic |
| ABNORMAL_SPREAD | order book > 5× max spread | automatic |
| EXCESSIVE_SLIPPAGE | realized live fill vs quote | human |
| EXCHANGE_API_ERRORS | ≥ 5 errors in 60 s, or an order with unknown outcome | human |
| RISK_ENGINE_UNAVAILABLE | self-test in the health job | automatic |
| DATABASE_UNAVAILABLE | Mongo disconnect or write failure | automatic |
| CLOCK_DRIFT | drift vs exchange server time > 1 s | automatic |
| UNEXPECTED_BALANCE_CHANGE / RECONCILIATION_MISMATCH | reconciliation | human |
| UNHEDGED_EXPOSURE | arbitrage leg mismatch | human |
| MANUAL_STOP / EMERGENCY_SHUTDOWN | admin | human |

## Backtesting

* Bar-by-bar. The strategy only sees `candles[0..i]` (closed). Orders decided at the close of bar *i* fill at the
  **open of bar *i+1*** with half-spread + slippage + fees. Stop and target are checked on the next bars' high and low.
  If both are touched in the same bar, the **stop is assumed first**. A gap through the stop fills at the open.
* The same `RiskEngine` sizes every trade, including the daily and weekly limits.
* Tests show that changing future data doesn't change past trades or equity (no look-ahead).
* Metrics: total return, win rate, profit factor (null if there are no losses), max drawdown, Sharpe, Sortino (annualized from
  bar returns; null when undefined), expectancy, average trade, number of trades, win and loss streaks, fees, slippage.
  A warning is shown if there are fewer than 30 trades.
* **Walk-forward:** parameters are chosen on TRAIN (grid, minimum trade count), confirmed on VALIDATION, then frozen for
  the unseen OUT-OF-SAMPLE window, which then rolls forward by the OOS length. Only the aggregated OOS metrics should
  be used to judge a strategy.

## Paper trading

`PaperBroker` re-reads the live order book **after** a simulated latency delay. It walks the book levels (market
impact), adds extra slippage, charges taker fees, returns partial fills (IOC remainder cancelled), rejects
randomly (`PAPER_REJECT_RATE`), and rejects when the book is missing or stale. Paper orders, positions and trades carry
`mode: 'PAPER'` (immutable) and every query is scoped by mode.

## Reporting

`GET /api/portfolio/report` reports **backtest**, **out-of-sample**, **paper** and **live** separately for each strategy
(never blended), always net of fees and slippage, with every losing trade included.
