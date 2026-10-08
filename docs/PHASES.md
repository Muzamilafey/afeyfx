# Development phases and verification log

Each phase was followed by: tests → fixes → log check → functional verification → docs → commit.

| # | Phase | Delivered | Verification |
|---|---|---|---|
| 1 | MERN architecture, auth, MongoDB, API, dashboard shell | Express 5 + TS, Mongoose models, JWT + rotating refresh, bcrypt, TOTP 2FA, RBAC, audit log | `api.test.ts`, `database.test.ts`, server boot smoke test against real MongoDB |
| 2 | Market data | REST backfill/polling, Binance native WS (reconnect, de-dup, closed klines), candle validation, gap backfill, staleness tracking | `marketData.test.ts`. Boot test with exchanges unreachable → `STALE_MARKET_DATA` and `EXCHANGE_API_ERRORS` tripped (fail closed) |
| 3 | Exchange adapters | `ExchangeAdapter`, CCXT base, Binance/Bybit/Coinbase, permission checks, withdrawal Proxy guard | `withdrawals.test.ts`, fake-client execution tests |
| 4 | Technical analysis | SMA, EMA, RSI, MACD, BB, ATR, ADX, Stochastic, VWAP, OBV, volume, S/R, volatility, momentum | `indicators.test.ts` (reference values, look-ahead invariance) |
| 5 | Strategy engine | Strategy contract, 6 strategies, regime gating, lifecycle stages | `strategies.test.ts`, `regime.test.ts` |
| 6 | Risk engine | Centralized fail-closed `RiskEngine`, `CircuitBreaker` | `risk.test.ts` (every rejection path) |
| 7 | Backtesting | Bar-by-bar engine, costs, walk-forward | `backtest.test.ts` (no look-ahead, next-open fills, stop-first, accounting identity) |
| 8 | Paper trading | `PaperBroker` (latency, book walking, partial fills, rejects), paper portfolio | `paperTrading.test.ts`, `execution.test.ts` |
| 9 | React dashboard | All pages, Socket.IO streaming, PAPER/LIVE banner | `client/tests`, headless-Chromium walkthrough (login, 2FA enrolment, protected stop-new-trades, backtest run) |
| 10 | Claude AI | Structured analysis, veto-only decision gate, strategy review → proposals | `aiDecision.test.ts`, `tradingEngine.test.ts` |
| 11 | Telegram | Notifications with redaction and throttling | `securityUtils.test.ts` |
| 12 | Live trading infrastructure | `LiveTradingGuard`, 10-check preflight, activation flow, reconciliation, protective stops, idempotent and verified execution | `liveTradingProtection.test.ts`, `execution.test.ts` |
| 13 | Security audit | See SECURITY.md (npm audit clean, findings table) | CI audit step |
| 14 | Production deployment | PM2, Nginx, HTTPS, scripts, runbooks | `bash -n` on scripts; `deploy.sh` gates on tests |

## Test summary

* Server: 16 suites, 177 tests, all passing, run against a real `mongod`
  (`MONGODB_TEST_URI` or mongodb-memory-server).
* Client: 5 component and utility tests, typecheck, production build.

## Known limitations (be aware before trading)

* **Exchange connectivity was not exercised against real exchanges in the build environment** (its network
  blocks exchange hosts). Adapters were tested against fake CCXT clients. **Run on Binance or Bybit testnet first**,
  and check order placement, protective stop orders (`stopLossPrice` mapping), fills, reconciliation and permission checks
  for your exact account type before you consider mainnet.
* Coinbase Advanced Trade has no spot sandbox. Permission verification relies on the key-permissions endpoint.
* Accounting assumes **spot** trading. Shorting is disabled by default. Derivatives positions are read by
  reconciliation but haven't been tested end to end.
* **News/sentiment:** the AI input schema accepts a `news` array, but no news provider is wired in, because no reliable
  source was specified. Add one only with a trustworthy feed, and keep treating its text as untrusted data.
* **Arbitrage** handles detection, cost modelling and two-leg order placement on pre-funded venues. Legging risk is real, and
  arbitrage fills are not yet folded into the portfolio P&L. Treat it as experimental and keep it in PAPER.
* Jobs use in-process node-cron in a single PM2 instance. BullMQ + Redis wasn't needed at this scale.
* A TOTP code can be replayed within its ±30 s window (an accepted risk; see SECURITY.md).
* Synthetic random-walk backtests lose money after costs, which is the expected behaviour for strategies with no edge.
  None of the bundled strategies has been shown to be profitable on real data. Treat them as starting points for research.
