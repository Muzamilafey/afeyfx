# REST API

Base path `/api`. Every endpoint except `/api/auth/register|login|2fa/verify|refresh|logout` and the public
`GET /health` needs `Authorization: Bearer <accessToken>`.
Roles: **V** = viewer+, **T** = trader+, **A** = admin. **🔐** = protected: admin with a second factor enabled, plus a fresh `totp` (authenticator) or `emailCode`
(from `POST /api/auth/2fa/email/send`) in the JSON body. System-book endpoints (signals, orders, positions, trades, portfolio, risk, AI, notifications, health) are admin-only; list endpoints show the system book unless `owner=all|<userId>` is passed.

Errors look like `{ "error": { "code": "...", "message": "...", "details"?: ... } }`.

## Auth `/api/auth`
| Method | Path | Notes |
|---|---|---|
| POST | `/register` | `{email,name,password}`. The first user becomes admin; after that it creates a **trader** (if `ALLOW_PUBLIC_SIGNUP`) |
| POST | `/login` | `{email,password,portal?:'trader'|'admin'}` → `{accessToken,user}` or `{requires2fa,challengeToken}`. Sets the refresh cookie |
| POST | `/2fa/verify` | `{challengeToken,code}` → `{accessToken,user}` |
| POST | `/refresh` | Uses the httpOnly cookie and rotates the token |
| POST | `/logout` | Revokes the refresh-token family |
| GET | `/me` | Current user |
| POST | `/2fa/setup` · `/2fa/confirm` `{code}` · `/2fa/disable` `{password?,code}` | Authenticator (TOTP) enrolment |
| GET | `/config` | Public: which sign-in methods are enabled (no secrets) |
| GET | `/google/start` · `/google/callback` · `/github/start` · `/github/callback` | Social sign-in (redirect flow, CSRF state cookie) |
| POST | `/google` `{credential}` | Alternative: verify a Google Identity Services ID token |
| POST | `/verify-email` `{uid,token}` · `/resend-verification` | Email verification |
| POST | `/2fa/email/send-login` `{challengeToken}` | Email a login code for a pending 2FA challenge |
| POST | `/2fa/email/send` `{context?}` · `/2fa/email/enable` `{code}` · `/2fa/email/disable` `{totp|emailCode}` | Email codes as a second factor |
| POST | `/password` `{currentPassword?,newPassword}` | Set (social-only accounts) or change the password |

## Personal demo account `/api/account` (any signed-in user; trading requires a verified email)
`GET /` (account + user) · `POST /orders` `{symbol,direction:'LONG'|'SHORT',investment,stopLossPct,takeProfitPct?,idempotencyKey?}` ·
`GET /positions?status=OPEN|CLOSED` · `POST /positions/:id/close` · `GET /history` · `GET /performance` · `POST /demo/reset` (only when flat)

Account endpoints take `?account=DEMO|REAL` (default DEMO); `GET /api/account` returns both accounts. Orders take
`account: "DEMO" | "REAL"`. REAL orders need the admin's real-trading switch and real market data.

## Payments `/api/payments` (traders; mutations need a verified email)
| Method | Path | Notes |
|---|---|---|
| GET | `/config` | Methods, limits, KES rates, fees, what is enabled (no credentials) |
| GET | `/` `?type=DEPOSIT\|PAYOUT` | Own transactions |
| GET | `/:id` | One own transaction |
| POST | `/deposits` | `{amount, phone, idempotencyKey}` → STK Push; status follows via Socket.IO `payment` |
| POST | `/payouts` | `{amount, phone, firstName, lastName, idempotencyKey, totp \| emailCode}`; funds held |
| POST | `/payouts/:id/cancel` | Only while pending; refunds the hold |
| POST | `/mpesa/stk/:token`, `/mpesa/b2c/result/:token`, `/mpesa/b2c/timeout/:token` | Daraja callbacks (public, secret token) |

## Admin payments `/api/admin/payments` (A; P = protected action with a fresh 2FA code)
`GET /config` · `PUT /config` (P) · `POST /config/test` · `GET /stats` · `GET /` `?type&status&q` ·
`POST /:id/approve` (P) · `POST /:id/reject` (P, `{note}`) · `POST /:id/resolve` (P, `{outcome, note, receipt?}`) · `POST /:id/requery`

## Brokers `/api/admin/brokers` (A)
`GET /` (routes, broker status, kill-switch state) · `PUT /deriv` (P, `{appId, token, multipliers}`) ·
`POST /:id/test` · `PUT /routes` (P, `{category: crypto|forex|metals, route: internal|deriv|oanda}`)

## Integrations `/api/admin/integrations` (A) and features
`GET /` (groups, masked secrets, sources, env-only list) · `PUT /` (P, `{values: {KEY: value}, reset: [KEY]}`) ·
`POST /:id/test` (email, anthropic, telegram, oanda, news, google, github).
`GET /api/features` (any signed-in user): which features are configured, so the UI can hide the rest.

## Users `/api/users` (A)
`GET /` · `POST /` `{email,name,password,role}` · `PATCH /:id` `{role?,active?,name?}`

## Exchanges `/api/exchanges`
`GET /` (V) · `GET /credentials` (A, masked) · `POST /credentials` 🔐 `{exchange,label,apiKey,apiSecret,passphrase?,testnet}`
(rejected if the key can withdraw) · `DELETE /credentials/:id` 🔐 · `POST /:name/verify` (A)

## Markets & market data
`GET /api/markets` (V) · `PATCH /api/markets/:id` (A)
`GET /api/market-data/summary` · `/candles?symbol&timeframe&limit` · `/orderbook?symbol` · `/analysis?symbol&timeframe` (indicators + regime)

## Strategies `/api/strategies`
`GET /` (V) · `PATCH /:key` (A) `{enabled?,symbols?,timeframes?,params?,allowedRegimes?,requireAiConfirmation?}` ·
`POST /:key/stage` 🔐 `{stage}` · `GET /:key/versions` (V) · `POST /:key/versions/:id/review` 🔐 `{decision}`

## Trading
| Method | Path | Notes |
|---|---|---|
| GET | `/api/signals?mode&strategy&symbol` | V |
| GET | `/api/orders?mode&status` · `/api/orders/:id` | V (with fills) |
| POST | `/api/orders` | T. **Paper only** manual order `{symbol,side,type,amount,price?,idempotencyKey?}` |
| POST | `/api/orders/:id/cancel` | T (live orders: A) |
| GET | `/api/positions?mode&status` | V |
| POST | `/api/positions/:id/close` | T (live positions: A) |
| GET | `/api/trades?mode&strategy&symbol&limit&skip` | V |
| GET | `/api/trades/:id/trace` | V. Full chain: user, signal, AI analysis, risk evaluation, orders, exchange responses, fills |

## Portfolio `/api/portfolio`
`GET /?mode` · `GET /performance?mode&groupBy=strategyKey|symbol|timeframe` · `GET /snapshots?mode&days` ·
`GET /report` (backtest / OOS / paper / live reported separately)

## Backtests `/api/backtests`
`GET /` · `GET /:id` · `POST /` (T) `{strategyKey,symbol,timeframe,type:'SIMPLE'|'WALK_FORWARD',params,config}` → 202 (runs asynchronously) ·
`POST /import-candles` (A) `{symbol,timeframe,days}`

## AI `/api/ai`
`GET /status` · `GET /news?symbol` (configured feeds only) · `GET /analyses?symbol&kind` · `POST /analyze` (T) `{symbol,timeframe}` · `POST /review/:key` (A, stores proposals only)

## Risk `/api/risk`
`GET /` (limits, breaker, exposure, daily/weekly loss) · `GET /events` · `PUT /config` 🔐 (bounded) · `POST /circuit-breaker/reset` 🔐 `{code|'ALL'}`

## Settings & notifications
`GET /api/settings` (trading state; no secrets) · `PUT /api/settings/ai` (A) ·
`GET /api/notifications` · `POST /api/notifications/:id/read` · `POST /api/notifications/test` (A)

## System `/api/system`
| Method | Path | |
|---|---|---|
| GET | `/health` | V. Component health |
| GET | `/audit-logs` · `/events` | A |
| POST | `/emergency/stop-new-trades` · `/emergency/resume` · `/emergency/cancel-orders` · `/emergency/close-positions` · `/emergency/shutdown` · `/emergency/clear-shutdown` | 🔐 four separate controls plus recovery actions |
| GET | `/live` | A. Status, last preflight, confirmation phrase |
| POST | `/live/preflight` | 🔐 |
| POST | `/live/enable` | 🔐 `{password, confirmation, totp}` (also needs `LIVE_TRADING_ENABLED=true` and a passing preflight < 5 min old) |
| POST | `/live/disable` | A (always allowed) |

## Socket.IO

Additional events: `candle-live` (the forming candle on every update, all users), `payment` (owner + admins).

Connect to `/socket.io` with `auth: { token: <accessToken> }`. Events: `price` (throttled to 4/s per symbol), `candle`,
`signal`, `order`, `trade`, `position`, `portfolio`, `risk`, `exchange-status`, `ai-analysis`, `system`.
