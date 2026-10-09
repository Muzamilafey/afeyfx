# AfeyFX — AI-assisted algorithmic trading platform

A MERN + TypeScript platform for market analysis, strategy research, backtesting, paper trading and
(guarded) live trading, with Claude as an advisory analyst. Traders get a chart-first terminal with crypto,
forex (40+ pairs) and metals, a demo account, and a real-money account funded and withdrawn through
**M-Pesa**. Real-account orders fill internally or are routed to an external broker (Deriv, OANDA).

> **Risk warning.** Trading is risky and you can lose money. Nothing in this project guarantees
> profit. A strategy has to show results in backtests, then out-of-sample tests, then paper trading,
> and a human has to approve it before it can trade live. The app starts in **PAPER** mode. **LIVE**
> mode stays disabled until an authorized admin explicitly turns it on.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, lightweight-charts, Socket.IO client |
| Backend | Node.js 22, Express 5, TypeScript |
| Database | MongoDB 7, Mongoose |
| Real-time | Socket.IO (dashboard), native Binance WebSocket (market data) |
| Trading | CCXT adapters (Binance, Bybit, Coinbase), exchange REST + WebSocket; brokers: Deriv (WebSocket API), OANDA v20 |
| Payments | Safaricom Daraja (M-Pesa STK Push + B2C) |
| AI | Claude API (`@anthropic-ai/sdk`), configurable model via env |
| Ops | Linux VPS, Nginx, PM2, HTTPS (Let's Encrypt) |

There is no Python in the project.

## Architecture

```
React dashboard ──REST──▶ Express API ──▶ Trading Engine
       ▲                                  │
       └────────── Socket.IO ◀── event bus ┤
                                          ▼
          Market Data ─▶ Strategy ─▶ AI analysis (veto only) ─▶ Risk Engine (final authority)
                                                                    ▼
                                         Execution (Paper broker │ LiveTradingGuard → Exchange adapter)
                                                                    ▼
                                                           Exchange REST / WS
MongoDB: users, markets, candles, strategies, signals, orders, fills, positions, trades,
portfolios, backtests, AI analyses, risk events, audit logs …
```

For more detail, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Safety model (summary)

* **Three modes:** `BACKTEST`, `PAPER` (the default), `LIVE`. Paper and live records are stored and reported separately.
* **Real orders are refused** unless *all* of these are true:
  `LIVE_TRADING_ENABLED=true` in the server env (it cannot be set from the UI), the mode is LIVE, an admin
  activated live mode (10-check preflight, password, fresh 2FA code and a typed confirmation phrase),
  the circuit breaker is closed, and trading is not stopped. These checks run in the execution
  service **and again inside every exchange adapter**.
* **Withdrawals are never supported.** Adapters expose no withdraw or transfer methods. The CCXT client is wrapped
  so that any `withdraw*` or `transfer*` call throws. API keys that have withdrawal permission are rejected,
  and so are keys whose permissions can't be verified.
* **Claude cannot place orders.** It gets no tools and no access to the execution layer. It can only veto a strategy
  signal. The **Risk Engine has final authority**.
* **Fail closed.** The circuit breaker stops new entries when data is stale, the exchange disconnects, the spread
  or slippage is abnormal, there are repeated API errors, a loss limit is hit, the clock drifts, the database is down,
  the balance changes unexpectedly, or reconciliation finds a mismatch.
* **Real-money accounts** (M-Pesa) are off until an admin configures and enables them. A deposit is
  credited exactly once, and only after M-Pesa confirms it (callback **and** an STK Push Query). Withdrawal funds
  are held atomically, sent only after admin approval (with a fresh 2FA code) unless the admin set an auto-approve
  limit, and refunded only on a definite failure. Ambiguous outcomes go to a review queue and are never refunded
  automatically. Real accounts never trade on simulated prices.
* **External brokers** (Deriv, OANDA) receive orders only with `LIVE_TRADING_ENABLED=true` **and** an admin route
  set after a passing connection test. Broker adapters have no deposit, withdrawal or transfer capability
  (request allow-lists), and the ledger books exactly the P&L the broker reports.
* **Every live trade is traceable** to user → strategy → signal → AI analysis → risk evaluation → orders →
  exchange responses → fills → P&L (`GET /api/trades/:id/trace`).

For more detail, see [docs/SECURITY.md](docs/SECURITY.md).

## Quick start (development)

Requirements: Node 20+ and a local MongoDB (or Docker: `docker run -d -p 127.0.0.1:27017:27017 mongo:7`).

```bash
cp .env.example .env            # then fill in the secrets: ./scripts/generate-secrets.sh
                                # no exchange access locally? set MARKET_DATA_SOURCE=simulated (dev only)
npm run install:all
npm run dev:server              # API + engine on :5000 (PAPER mode)
npm run dev:client              # dashboard on http://localhost:5173 (proxies /api and /socket.io)
```

1. Open `/admin/login` and create the first account (it becomes the admin). Traders sign up at `/signup`.
2. Verify your email (without SMTP in dev, the link is printed in the server log), then enable 2FA in
   Account & 2FA (authenticator or email codes). Protected actions need it.
3. Import history: Backtests → *Import history*, or `npm --prefix server run import-candles -- BTC/USDT 1h 365`.
4. Run backtests and a walk-forward test, then promote a strategy through its lifecycle to **PAPER** and enable it.

## Tests

```bash
npm test                        # server (vitest + real MongoDB) and client (vitest + jsdom)
```

The server tests need MongoDB. They use `mongodb-memory-server`, which downloads `mongod` automatically.
You can also point them at an existing instance with `MONGODB_TEST_URI=mongodb://127.0.0.1:27017`.

Notable suites:

* `liveTradingProtection.test.ts`: shows that LIVE orders can't be sent when `LIVE_TRADING_ENABLED=false`
  (the guard, the adapter, the execution service and the API all refuse, and the exchange client is never called).
* `withdrawals.test.ts`: shows that withdrawal or transfer endpoints are never called or reachable, that keys with
  withdrawal permission are flagged, and that preflight fails for them.
* The remaining suites cover indicators, regimes, strategies, risk, backtesting (look-ahead checks), walk-forward,
  the paper broker, execution (idempotency, timeout recovery), AI decision rules, the full trading-engine pipeline,
  auth/RBAC/2FA, API security, WebSockets, the database and market data.

## Project structure

```
server/src/  config controllers routes middleware models services exchanges marketData strategies
             risk execution portfolio backtesting ai notifications websocket utils jobs types
             app.ts server.ts
client/src/  components pages layouts hooks services websocket charts types utils App.tsx main.tsx
docs/        architecture, security, deployment, operations, API, strategies & risk, phase log
scripts/     setup-vps, deploy, backup, restore, healthcheck, emergency-stop, generate-secrets
deploy/      nginx site + proxy snippet, mongod.conf, logrotate
ecosystem.config.cjs   PM2
```

## Screenshots

These were captured from the running app with headless Chromium, using the development-only
**simulated market feed** (exchanges are unreachable in the sandbox where they were taken). The "SIMULATED
MARKET DATA" badge is shown whenever that feed is on.

| | |
|---|---|
| ![Trader terminal](docs/screenshots/07-terminal-dark.png) | ![Terminal light](docs/screenshots/11-terminal-light.png) |
| Trader terminal (dark) | Trader terminal (light) |
| ![Login](docs/screenshots/03-trader-login-light.png) | ![Admin login](docs/screenshots/01-admin-login.png) |
| Trader sign-in: Google, GitHub, email | Separate admin console sign-in |
| ![Email 2FA](docs/screenshots/14-login-email-2fa-dark.png) | ![Security](docs/screenshots/15-account-security-dark.png) |
| Sign-in with an emailed code | Account security (2FA, email codes, password, linked logins) |
| ![Admin dashboard](docs/screenshots/18-admin-dashboard-dark.png) | ![Emergency](docs/screenshots/19-admin-emergency-email-code.png) |
| Admin console | Protected action confirmed with an email code |
| ![Mobile](docs/screenshots/16-mobile-terminal-dark.png) | ![Markets](docs/screenshots/12-markets-light.png) |
| Mobile | Markets |
| ![Deposit](docs/screenshots/26-deposit-methods.png) | ![M-Pesa form](docs/screenshots/27-deposit-mpesa-form.png) |
| Deposit: payment methods | M-Pesa deposit (STK Push) |
| ![Check phone](docs/screenshots/28-deposit-check-phone.png) | ![Received](docs/screenshots/29-deposit-received.png) |
| Waiting for the customer's PIN | Deposit confirmed and credited |
| ![Withdrawal](docs/screenshots/35-withdrawal-form.png) | ![Payments](docs/screenshots/41-payments-history-light.png) |
| Withdrawal to M-Pesa | Payments history |
| ![Forex picker](docs/screenshots/32-asset-picker-forex.png) | ![Gold](docs/screenshots/33-terminal-gold-live-candles.png) |
| Crypto / Forex / Metals picker | Gold with live candles and open trades |
| ![Admin payments](docs/screenshots/38-admin-payments-review.png) | ![Integrations](docs/screenshots/22-admin-integrations-github-active.png) |
| Admin: withdrawal review queue | Admin: integrations (missing keys = hidden features) |
| ![Brokers](docs/screenshots/24-admin-brokers-locked.png) | ![M-Pesa settings](docs/screenshots/23-admin-mpesa-settings.png) |
| Admin: broker routing (locked until the env kill switch is on) | Admin: M-Pesa settings |
| ![Brokers page](docs/screenshots/44-brokers-empty.png) | ![MT5 connected](docs/screenshots/46-brokers-positions.png) |
| Trader: Brokers page (unconfigured providers hidden) | Trader: MT5 demo account connected (simulated terminal) |
| ![Order preview](docs/screenshots/47-brokers-order-preview.png) | ![Emergency close](docs/screenshots/48-brokers-emergency-confirm.png) |
| Order ticket with server-side risk preview | Emergency close confirmation |
| ![1 week](docs/screenshots/51-terminal-1w.png) | ![1 month](docs/screenshots/52-terminal-1m.png) |
| Weekly candles (simulated data) | Monthly candles (simulated data) |

## Accounts & sign-in

* **Traders** sign up at `/signup` with email and password, **Continue with Google** or **Continue with GitHub**.
  Each trader gets a personal **$10,000 demo (PAPER) account**, isolated from other users and from the
  system strategy book. Placing trades requires a **verified email**.
* **Admins** sign in at `/admin/login` (admin accounts only) and use the admin console at `/admin`. The first
  account ever created becomes the admin, or you can run `npm --prefix server run create-admin`.
* **Second factors:** an authenticator app (TOTP) and/or **email codes**. Both work at login and for every
  protected admin action. Google and GitHub sign-in never bypass 2FA.
* **Light / dark / system theme** everywhere (toggle in the header or under Account → Appearance).
* **Live account:** a second, real-money account per trader (switch in the header menu). See below.

## Real-money accounts, M-Pesa and brokers

* **Deposit** (header button): choose M-Pesa, enter the amount in USD and an M-Pesa number. The customer approves
  an STK Push prompt on their phone, and the deposit is credited to the **Live account** once M-Pesa confirms it.
* **Withdrawal** page: amount, M-Pesa method, first/last name and phone. Confirmed with an authenticator code
  (or an emailed code for traders without 2FA). Funds are held immediately; an admin approves and the payout
  is sent with M-Pesa B2C. Withdrawals go only to numbers that made a deposit (configurable). Fee, limits and the
  KES rate are set by the admin.
* **Payments** page: every deposit and payout with status, fee and KES amount.
* **Admin → Payments:** Daraja credentials (encrypted), paybill/till, B2C initiator, rates, limits, fees,
  auto-approve threshold, callback URLs and IP allow-list, a review queue (approve / reject / resolve) and
  24h totals. Environments: Sandbox, Production, and Simulated (development only, refused in production).
* **Admin → Brokers:** route each asset class (crypto / forex / metals) to *Internal* (fills at the live
  market price), **Deriv** (Multiplier contracts with broker-side stop loss / take profit) or **OANDA** (FOK market
  orders with attached SL/TP). Positions closed at the broker are synced; unknown broker positions are reported.
  New brokers plug in by implementing one adapter interface.
* **Brokers page (`/brokers`):** traders connect their **own** Deriv accounts (OAuth with PKCE, or a trade-only
  token) and MetaTrader 5 accounts (via the AfeyFX Bridge EA in their terminal; the MT5 password never leaves it).
  Each account card shows its status, masked id, demo/real badge, balance/equity/margin, positions, orders, history,
  logs and latency. It has per-account risk limits, a risk-previewed order ticket, strategy → account routing and
  emergency cancel/close (closes count only when the broker confirms them). Real-money trading stays locked unless
  `LIVE_TRADING_ENABLED` and `BROKER_USER_LIVE_ALLOWED` are both on and the user confirms with password, 2FA and a
  typed phrase. These integrations are **mock-tested only**: see [docs/BROKERS.md](docs/BROKERS.md) for setup,
  the MT5 protocol, the provider evaluation and the demo verification checklist.
* **Admin → Integrations:** every `.env` integration key (SMTP, Google, GitHub, Anthropic, Telegram, OANDA, news,
  public URLs, sign-up policy) can be set in the console. Secrets are encrypted and never shown again, values apply
  immediately, and **features whose keys are missing are hidden** (sign-in buttons, AI pages, Telegram tests,
  forex markets, deposit/withdrawal buttons). Bootstrap and safety settings stay environment-only.
* Operating real-money accounts requires the licences that apply in your jurisdiction and a Safaricom paybill/till
  with B2C enabled.

## Markets

Crypto (18 USDT pairs by default, `TRADER_CRYPTO_SYMBOLS`), forex majors, crosses and exotics (EUR/USD, GBP/USD,
USD/JPY, EUR/GBP, GBP/JPY, AUD/NZD, USD/ZAR, … 41 pairs) and metals (XAU, XAG, XPT, XPD). Forex and metal prices come
from OANDA v20 pricing; markets outside the forex session are marked **closed** and refuse orders. P&L on pairs quoted
in another currency (e.g. USD/JPY) is converted to USD at live rates. Charts update **tick by tick**: every trade and
every update of the forming candle is streamed (Binance `aggTrade` + kline streams; OANDA quotes). Chart timeframes: 1m, 5m, 15m,
1h, **4h, 1 day, 1 week and 1 month**. The long ones are calendar-aligned in UTC (weeks start Monday, months on
the 1st). They come from the venue's own candles (Binance, OANDA H4/D/W/M) or from stored hourly candles, and the
forming candle still moves on every tick.

## Documentation

* [Architecture](docs/ARCHITECTURE.md)
* [Security](docs/SECURITY.md)
* [Deployment (VPS, Nginx, PM2, HTTPS, MongoDB)](docs/DEPLOYMENT.md)
* [Operations: monitoring, backups, emergency shutdown, enabling live](docs/OPERATIONS.md)
* [Strategies & risk](docs/STRATEGIES_AND_RISK.md)
* [Broker connections: Deriv, MT5 bridge, provider evaluation](docs/BROKERS.md)
* [REST API](docs/API.md)
* [Development phases & verification log](docs/PHASES.md)
