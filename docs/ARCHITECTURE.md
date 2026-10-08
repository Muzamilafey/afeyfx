# Architecture

## Process model

A single Node.js process (managed by PM2, fork mode, one instance) runs the following:

* the **Express REST API** (`/api/*`) and the public `/health` endpoint
* the **Socket.IO** server (`/socket.io`) for dashboard streaming
* the **market-data service** (REST backfill/polling plus a native Binance WebSocket)
* the **trading engine** and the **background jobs** (node-cron)

Nginx serves the built React app and reverse-proxies `/api`, `/socket.io` and `/health` to `127.0.0.1:5000`.
MongoDB listens only on `127.0.0.1`.

The trading engine runs in a single process on purpose: two engines would mean duplicate orders. If you ever
scale the API horizontally, run jobs in exactly one process (`JOBS_ENABLED=true` there only) or move them to
BullMQ + Redis. Every order is protected by a unique idempotency key in any case.

## Data flow for a trade

```
closed candle ─▶ StrategyEngine (scan job, :05 past each minute)
   │  MarketRegimeService.detect()          (only on CLOSED candles)
   │  strategy.generateSignal()             (regime-gated, declares its own indicators)
   ▼
Signal (unique per strategy/symbol/timeframe/candle/mode → no duplicates)
   │  fast-fail: trading stopped? breaker open? live guard?
   │  ClaudeService.analyzeMarket()         (structured JSON, validated with zod; VETO only)
   │  RiskEngine.evaluate()                 (sizing, exposure, limits, spread, liquidity, expected profit …)
   │  DecisionService.decide()              (EXECUTE only if every critical check passes)
   ▼
PositionManager.open()
   │  OrderExecutionService.submit()        (idempotency key = exchange clientOrderId)
   │     PAPER → PaperBroker (fees/spread/slippage/latency/partial fills/rejections)
   │     LIVE  → LiveTradingGuard → ExchangeAdapter.createOrder (guard again) → verify via fetchOrder → fills
   ▼
Position (from ACTUAL filled qty / avg price) ─▶ monitor job (SL / TP / trailing) ─▶ Trade (net of all fees)
```

## Modules (server/src)

| Directory | Responsibility |
|---|---|
| `config/` | zod-validated env (safe defaults; production refuses weak secrets), MongoDB connection |
| `models/` | 22 Mongoose models (User, Exchange, ExchangeCredential, Market, Candle, Strategy, StrategyVersion, Signal, Order, Fill, Position, Trade, Portfolio, PortfolioSnapshot, Backtest, BacktestRun, AIAnalysis, RiskEvent, SystemEvent, Notification, AuditLog, Settings, RefreshToken) |
| `exchanges/` | `ExchangeAdapter` interface, `CcxtAdapter` (withdrawal guard, order mapping), Binance/Bybit/Coinbase adapters (permission verification), registry |
| `marketData/` | `MarketDataService`, `BinanceWsStream` (reconnect, heartbeat, de-dup), `MarketDataCache`, `CandleStore`, candle validation |
| `services/analysis/` | `TechnicalAnalysisService` (+ pure indicator functions), `MarketRegimeService` |
| `strategies/` | `Strategy` interface + `BaseStrategy`, six strategies, registry |
| `risk/` | `RiskEngine` (pure, deterministic), `CircuitBreaker` |
| `execution/` | `TradingEngine`, `OrderExecutionService`, `PaperBroker`, `PositionManager`, `LiveTradingGuard`, `LivePreflight` |
| `portfolio/` | `PortfolioService` (per-mode accounting, snapshots, grouped performance), `metrics` |
| `backtesting/` | `BacktestEngine` (bar-by-bar), `WalkForwardAnalyzer` |
| `ai/` | `ClaudeService`, `DecisionService`, prompts, schemas. No imports from `exchanges/` or `execution/` (enforced by a test) |
| `notifications/` | Telegram client (secret redaction), `NotificationService` |
| `services/` | auth, settings and trading state, live mode, emergency, reconciliation, arbitrage, health, audit |
| `websocket/` | Socket.IO with JWT handshake; streams event-bus events (price updates are throttled) |
| `jobs/` | scheduler: strategy scan, position monitor, risk checks, snapshots, stale orders, reconciliation, health, arbitrage |

## Market data guarantees

* Only **closed** candles are stored or used. REST candles still in progress are rejected, and only WS klines with `x=true` are accepted.
* Candles must be aligned to the timeframe, have sane OHLC values, and not be in the future. Gaps are detected and backfilled.
* The unique index `(exchange, symbol, timeframe, timestamp)` combined with upserts means there are no duplicate candles.
* WebSocket events are de-duplicated (bookTicker `u`, kline open time). Out-of-order tickers are dropped.
* There is a heartbeat watchdog, reconnection with exponential backoff and jitter, and a proactive reconnect before the 24h limit.
* Data age is tracked per symbol. If the data is stale, the `STALE_MARKET_DATA` breaker trips (it resets itself on recovery).

## Real-time UI

Socket.IO events: `price`, `candle`, `signal`, `order`, `trade`, `position`, `portfolio`, `risk`,
`exchange-status`, `ai-analysis`, `system`. The dashboard subscribes instead of polling. The only timers in the
client are a 60-second safety refresh of the mode/status and a refresh while a backtest is running.
