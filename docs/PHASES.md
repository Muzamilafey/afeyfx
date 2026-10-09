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
| 15 | Completion pass | Arbitrage P&L accounting with legging protection; RSS/Atom news input and AI news sentiment; promotion gates require backtests with ≥5 trades; testnet status fallback; responsive header; screenshot set | `arbitrage.test.ts`, `news.test.ts`, stage-gate API test, headless-Chromium walkthrough (`docs/screenshots/`) |
| 16 | Accounts, sign-in & trader terminal | Email verification; email-code 2FA; Continue with Google/GitHub; trader sign-up and separate admin portal; personal demo accounts; chart-first trader terminal; light/dark theme; dev-only simulated feed | `authExtended.test.ts`, `demoAccount.test.ts`, websocket routing test, full headless-browser walkthrough (sign-up → email verification → trades → email 2FA → admin console) |
| 17 | Real money, markets & brokers | M-Pesa deposits (STK Push + query confirmation) and withdrawals (B2C, held funds, admin approval, review queue); REAL accounts; forex (41 pairs) + metals via OANDA with USD conversion; 18 crypto pairs; tick-by-tick candles; admin Integrations (all .env keys, hidden features); broker routing (Deriv, OANDA) behind the live kill switch | `payments.test.ts`, `forex.test.ts`, `brokers.test.ts`, `integrations.test.ts`, headless-browser walkthrough (admin setup → integrations → M-Pesa config → deposit → forex trading → withdrawal → admin approval) |
| 18 | Multi-broker accounts | User broker connections: Deriv (current API: OAuth PKCE/PAT, OTP WebSocket, Multipliers + Rise/Fall), MT5 via the HMAC-signed AfeyFX Bridge EA; capability registry; per-account risk, breakers, reconciliation, emergency controls; DEMO mode; strategy → account routing; Brokers page; docs/BROKERS.md | `brokerConnections.test.ts` (mocked Deriv REST/WS and a simulated MT5 terminal), headless-browser walkthrough of the Brokers page. **Not verified against real broker accounts**; the EA is not compiled in CI |

## Test summary

* Server: 24 suites, 262 tests, all passing, run against a real `mongod`
  (`MONGODB_TEST_URI` or mongodb-memory-server).
* Client: 11 component and utility tests, typecheck, production build.

## Known limitations (be aware before trading)

* **Exchange connectivity was not exercised against real exchanges in the build environment** (its network
  blocks exchange hosts). Adapters were tested against fake CCXT clients. **Run on Binance or Bybit testnet first**,
  and check order placement, protective stop orders (`stopLossPrice` mapping), fills, reconciliation and permission checks
  for your exact account type before you consider mainnet.
* Coinbase Advanced Trade has no spot sandbox. Permission verification relies on the key-permissions endpoint.
* Accounting assumes **spot** trading. Shorting is disabled by default. Derivatives positions are read by
  reconciliation but haven't been tested end to end.
* **News/sentiment** comes only from RSS/Atom feeds that you configure (`NEWS_ENABLED`, `NEWS_RSS_URLS`). It is off by default.
  Headlines are sanitized, must be dated and recent, are filtered by symbol, and are passed to Claude as untrusted data.
  Claude reports a `newsSentiment` that is shown on the dashboard and stored with each analysis. Pick feeds you trust;
  the platform can't vouch for their accuracy.
* **Arbitrage** sends both legs as IOC limit orders on pre-funded venues. The hedged quantity is booked as one trade, and its
  net P&L (after fees) goes into the portfolio. A partial or one-sided fill trips `UNHEDGED_EXPOSURE` (manual reset),
  disables the strategy and sends an alert. Legging risk can't be removed entirely, so keep it in PAPER until you've tested it on testnet.
* Jobs use in-process node-cron in a single PM2 instance. BullMQ + Redis wasn't needed at this scale.
* An authenticator (TOTP) code can be replayed within its ±30 s window (an accepted risk; email codes are single-use; see SECURITY.md).
* Google/GitHub sign-in was tested with mocked provider endpoints and checked up to the provider redirect.
  Register real OAuth apps (callback URLs in `.env.example`) and test the full round trip before relying on it.
* **M-Pesa** was tested against mocked Daraja endpoints and the built-in simulated provider. Run the Daraja
  **sandbox** end to end (deposit, cancel, wrong PIN, payout, timeout) with your shortcode before production.
* **User broker connections (Deriv, MT5)** were tested with mocked Deriv endpoints and a simulated MT5 terminal only;
  the MQL5 EA has not been compiled here. Follow the verification checklist in docs/BROKERS.md on demo accounts.
  MT5 pending/modify/cancel/partial-close have no automated test yet.
* **Deriv and OANDA execution** was tested with mocked broker responses only. Use a Deriv demo (VRTC) account and
  an OANDA practice account first. Deriv sizing uses Multiplier contracts (stake = investment ÷ multiplier).
* Forex prices need OANDA credentials; without them forex/metals are hidden. Weekend sessions are closed.
* P&L for pairs quoted in another currency is converted at the live rate at close; collateral uses the entry rate.
* Synthetic random-walk backtests lose money after costs, which is the expected behaviour for strategies with no edge.
  None of the bundled strategies has been shown to be profitable on real data. Treat them as starting points for research.
