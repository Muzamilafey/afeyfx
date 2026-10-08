# REST API

Base path `/api`. Every endpoint except `/api/auth/register|login|2fa/verify|refresh|logout` and the public
`GET /health` needs `Authorization: Bearer <accessToken>`.
Roles: **V** = viewer+, **T** = trader+, **A** = admin. **🔐** = protected: admin with 2FA enabled, plus a `totp` field
(current 6-digit code) in the JSON body.

Errors look like `{ "error": { "code": "...", "message": "...", "details"?: ... } }`.

## Auth `/api/auth`
| Method | Path | Notes |
|---|---|---|
| POST | `/register` | `{email,name,password}`. Only works while no users exist (the first user becomes admin) |
| POST | `/login` | `{email,password}` → `{accessToken,user}` or `{requires2fa,challengeToken}`. Sets the refresh cookie |
| POST | `/2fa/verify` | `{challengeToken,code}` → `{accessToken,user}` |
| POST | `/refresh` | Uses the httpOnly cookie and rotates the token |
| POST | `/logout` | Revokes the refresh-token family |
| GET | `/me` | Current user |
| POST | `/2fa/setup` · `/2fa/confirm` `{code}` · `/2fa/disable` `{password,code}` | TOTP enrolment |

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
Connect to `/socket.io` with `auth: { token: <accessToken> }`. Events: `price` (throttled to 4/s per symbol), `candle`,
`signal`, `order`, `trade`, `position`, `portfolio`, `risk`, `exchange-status`, `ai-analysis`, `system`.
