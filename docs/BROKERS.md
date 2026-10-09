# Broker connections (Deriv, MetaTrader 5)

Traders connect **their own** broker accounts on the **Brokers** page (`/brokers`). This is separate from the
admin's platform routing (Admin → Brokers), which sends the platform's REAL-account book to Deriv/OANDA.

> **Status: implemented, not yet verified against a real broker.** Every integration below was tested with mocked
> broker responses (Deriv REST/WebSocket and a simulated MT5 terminal). No test touched a real Deriv or MT5
> account, and the MQL5 Expert Advisor has not been compiled in CI. Run the [verification checklist](#verification-checklist-before-relying-on-an-integration)
> on demo accounts before relying on any of it. No provider is marked production-ready.

## Architecture

```
React /brokers ──REST──► /api/brokers/* (auth, ownership, validation, rate limits, audit, idempotency)
                         │
                         ├─ BrokerConnectionService   connect / test / sync / disconnect / limits / live gating
                         ├─ BrokerAuthenticationService  Deriv OAuth (PKCE), PAT, token refresh, MT5 terminal secrets
                         ├─ BrokerOrderService        validate → risk → idempotency → submit → broker confirmation
                         ├─ BrokerRiskService         per-account sizing + checks (server-side, final authority)
                         ├─ BrokerReconciliationService  broker is authoritative (every minute + on startup)
                         ├─ BrokerMarketData / Account / Health / Position services
                         └─ BrokerRegistry ──► adapter per connection (BrokerAdapter interface)
                                                ├─ DerivConnectionAdapter  (current Deriv API: REST + OTP WebSocket)
                                                └─ Mt5BridgeAdapter ◄── HTTPS (HMAC) ── AfeyFX Bridge EA in the user's MT5
Socket.IO: `broker` events go only to the owner's room (`user:<id>`).
TradingEngine signal ──► BrokerStrategyDispatcher ──► only accounts explicitly assigned to that strategy
```

* `server/src/brokers/core/types.ts`: the `BrokerAdapter` interface and normalized types. If an operation isn't
  supported, the adapter throws `BrokerUnsupportedError`. It never fakes success.
* `server/src/brokers/core/capabilities.ts` is the capability registry. For each operation it records whether
  it is implemented, unsupported or not implemented, and whether a mock test covers it. When a connection test
  passes against a real session, the server records it in `BrokerCapability` (`verifiedOn: demo|real`).
* Models:
  * `BrokerConnection`: holds the encrypted credentials. It has a unique index on `(user, provider, accountId)`.
  * `BrokerAccountSnapshot`, `BrokerSyncLog`, `BrokerEvent`, `MarketInstrument`, `MarketQuote`,
    `StrategyAccountAssignment`, `BrokerCapability`, `BrokerOAuthState`, `Mt5Command` and `BrokerNonce`.
  * `Order`, `Position`, `Trade` and `Fill` (`OrderExecution`) gained a `connection` field and the `DEMO` mode.

### Order pipeline

The pipeline runs: data → validation → risk approval → idempotency → broker submission → broker confirmation →
position record → reconciliation.

* **Fills:** an order is `FILLED` only after the broker confirms it.
  * Deriv: the contract is verified with `proposal_open_contract`.
  * MT5: the terminal's execution report, a trade-server retcode.
* **Ambiguous outcomes:** a timeout or a lost connection does not count as a rejection. The broker is queried
  first: Deriv via `portfolio`, MT5 via the command id in the order comment.
  * If the order still can't be resolved, it stays `UNKNOWN` and the API returns **202**.
  * The account then halts new orders (its circuit breaker trips) until reconciliation settles the order.
  * Nothing is retried blindly.
* **Idempotency:** `idempotencyKey` is unique per connection. Repeating a key returns the original order and
  sends nothing new.
* **AI and risk:** the AI never sends orders. Strategy signals pass through `decide()` (which includes the AI
  gate) and then through the per-account risk engine. High AI confidence alone never places an order.

### Per-account risk (defaults, editable within bounds)

| Limit | Default |
|---|---|
| Risk per trade | 0.5 % of equity |
| Daily / weekly loss | 2 % / 5 % (from UTC day/week start equity) |
| Max leverage | 1x |
| Max open positions | 3 |
| Max exposure | 20 % of equity |
| Max spread / slippage | 0.2 % / 0.3 % |
| Max quote age | 10 s |
| Halt after consecutive failures | 3 |
| Unexplained balance change tolerance | 1 % |

**Sizing is in account currency:**
* CFD: loss per lot = |entry − stop| × tickValue / tickSize.
* Multiplier: stake = min(risk budget / stop %, exposure room) / multiplier.
* Rise/Fall: the stake is the maximum loss.

The final size is the smallest of the risk budget, the exposure cap and the leverage cap, rounded down to the
broker's volume step.

**The account halts new orders when any of these happens:**
* the daily or weekly loss limit is hit
* the quote is stale or missing
* the connection is lost
* an unexplained balance change is found (checked during reconciliation)
* an execution can't be verified (`UNKNOWN`)
* reconciliation finds a mismatch
* the consecutive-failure limit is reached
* the platform-wide emergency stop is on
* the risk engine or database is unavailable (an exception rejects the order)

Spread, slippage, missing stops and wrong-side stops reject the single order.

### Modes and live gating

`BACKTEST` and `PAPER` are internal. Orders on a broker **demo** account are recorded as `DEMO`, and orders on
a **real** account as `LIVE`. All of the following must be true before a real-account order can be sent:

1. `LIVE_TRADING_ENABLED=true` (server environment; default `false`, never settable from the UI).
2. `BROKER_USER_LIVE_ALLOWED=true` (server environment; default `false`).
3. The user enabled live on that connection: typed `ENABLE LIVE TRADING`, entered their password and a fresh 2FA
   code, and a connection test proved the account is real.
4. Trading is enabled on the connection, its breaker is not tripped, and the platform emergency stop is off.
5. For strategy orders: the strategy is at the `LIVE` stage.

There is no fallback between demo and real accounts:
* A demo connection refuses a real session, and a real connection refuses a demo session.
* For Deriv this is checked on the account type and on the OTP WebSocket URL.
* For MT5 it is checked on the terminal's reported trade mode.

### Emergency controls

Each control is a separate action with its own confirmation:

| Control | Where |
|---|---|
| Stop new trades (platform) | Admin console emergency stop |
| Disable a strategy | Admin → Strategies, or pause the assignment |
| Disable an account | **Disable trading** on the account |
| Cancel pending orders | **Cancel all orders** |
| Close positions | **Close all positions** (disables trading first) |
| Safe engine shutdown | `SIGTERM`: jobs stop, broker sessions close |
| Admin: disable every user broker account | Admin → Brokers (protected action) |

A close counts as successful only after the broker confirms it. Each position reports `confirmed: true|false`
with the broker's message.

If an MT5 close is confirmed but its realized P&L has not arrived yet, the trade is not booked with a guess.
Reconciliation books it once the closing deal is reported.

---

## Deriv

The integration uses the **current** Deriv API (developers.deriv.com). Deriv calls the products "Options" and
"Multipliers"; forex CFDs are not offered through this API. Deriv contracts are **not** treated as forex market
orders:

* **Multipliers** (`MULTUP`/`MULTDOWN`): stake × multiplier exposure. Stop loss and take profit are amounts in
  account currency (`limit_order`).
* **Rise/Fall** (`CALL`/`PUT`): a stake for a fixed duration that settles automatically at expiry.

### How it connects

1. REST `GET options/accounts` with `Authorization: Bearer <token>` (plus `Deriv-App-ID` for PATs) lists the
   user's accounts.
2. REST `POST options/accounts/{id}/otp` returns a **single-use** WebSocket URL
   (`…/options/ws/{demo|real}?otp=…`). A fresh OTP is fetched for every (re)connection. The `demo|real` segment
   must match the connection.
3. The WebSocket carries the following:
   * `req_id` correlation
   * a 15 s request timeout
   * a `ping` every 30 s
   * a reconnect when no message arrives for 90 s
   * up to 5 reconnects with backoff, re-subscribing after each one
   * a 15 s cool-down after a rate-limit error
4. Only these message types are allowed: `ping time balance active_symbols contracts_for ticks ticks_history forget
   forget_all proposal buy sell proposal_open_contract portfolio statement profit_table`. Any key that looks like
   withdraw, transfer, cashier, payment, P2P or deposit is refused before sending.

### Register the app (admin)

1. Go to developers.deriv.com and register an application.
2. Set the **redirect URL** to `<API_PUBLIC_URL or APP_URL>/api/brokers/deriv/callback`, for example
   `https://trade.example.com/api/brokers/deriv/callback`.
3. Request the **trade** scope only. AfeyFX refuses a grant that includes `payment`.
4. Put the client id in `DERIV_CLIENT_ID` (or Admin → Integrations → *Deriv broker connections*). Set
   `DERIV_APP_ID` if users may paste Personal Access Tokens (`DERIV_ALLOW_PAT=true`).

### Connect (trader)

* **Connect Deriv** starts OAuth 2.0 authorization-code with PKCE (S256).
  * The `state` value is single-use, expires in 10 minutes and is bound to the browser by an httpOnly cookie
    scoped to `/api/brokers`.
  * The code is exchanged on the server. Tokens are encrypted (AES-256-GCM) and never sent to the browser.
  * Each Deriv account becomes its own connection.
  * Trading starts **disabled**.
* **Token fallback:** paste a PAT that has *Trade* + *Read* scopes only.
* **Disconnect** deletes the stored tokens. Deriv has no documented revoke endpoint that we could confirm, so
  also remove AfeyFX under Deriv → Settings → Security.

### Verified vs assumed

The docs and Deriv's template repository were only partly reachable from the build environment, so these items
are assumptions to verify on a demo account:
* the REST paths
* the OTP response shape
* the `underlying_symbol` field name
* the OAuth URLs (`DERIV_AUTH_URL`, `DERIV_TOKEN_URL`)
* refresh-token availability

All of these are configurable or isolated in `server/src/brokers/deriv/DerivApi.ts`.

---

## MetaTrader 5 bridge

MT5 has no official cloud trading API for retail accounts. The supported option is to run an Expert Advisor in
the user's own terminal (desktop or VPS). AfeyFX never receives the MT5 password.

### Install

1. On the Brokers page, choose **Connect MT5** and pick *Demo* or *Real*. Copy the **Bridge URL**, the
   **Terminal ID** and the **terminal secret**. The secret is shown once; **Rotate terminal secret** issues a new
   one.
2. Copy `bridge/mt5/AfeyFXBridge.mq5` to `MQL5/Experts/`, then compile it in MetaEditor.
3. In MT5, open Tools → Options → Expert Advisors. Enable *Allow algorithmic trading* and add your AfeyFX origin
   to *Allow WebRequest for listed URL*.
4. Save the secret, on one line, to `MQL5/Files/AfeyFXBridge/secret.txt`. It is deliberately not an EA input, so
   it never shows on charts or in screenshots.
5. Attach the EA to one chart and set its inputs:
   * `BridgeUrl` and `TerminalId`
   * `QuoteSymbols`, the broker's exact names (e.g. `EURUSDm` on Exness)
   * `AllowRealAccount`: leave it `false` unless this is a real account you have enabled for live trading
6. Turn on Algo Trading, then press **Test** on the connection.

### Protocol (server: `server/src/brokers/mt5/Mt5Bridge.ts`)

Every request is `POST /api/bridge/mt5/<endpoint>` and carries these headers:

```
X-AFX-Terminal:  <terminalId>
X-AFX-Timestamp: <unix ms>          (±MT5_BRIDGE_MAX_SKEW_MS, default 60 s)
X-AFX-Nonce:     <unique per request> (replays rejected)
X-AFX-Signature: hex(HMAC-SHA256(secret, ts \n nonce \n POST \n path \n hex(sha256(body))))
```

| Endpoint | Body | Response |
|---|---|---|
| `hello` | login, server, company, currency, tradeMode (demo/real/contest), leverage, eaVersion | `{ok, pollMs, heartbeatMs}`. The first hello binds the MT5 login. A different login, or demo/real mismatch → refused and trading disabled |
| `heartbeat` | balance, equity, margin, freeMargin, marginLevel, positions[], orders[], recent deals[] | pending commands (text) |
| `symbols` | symbol specs (digits, contractSize, tickSize, tickValue, volume min/max/step, tradeMode) | `{ok}` |
| `quotes` | `[{s, b, a, t}]` | `{ok}` |
| `poll` | `{}` | pending commands (text) |
| `reports` | `[{commandId, status, retcode, order, deal, position, price, volume, message}]` | `{ok}` (first report per command wins) |

Commands are returned one per line:
`CMD|commandId|type|symbol|side|orderType|volume|price|sl|tp|ticket|deadlineEpochSec`.

The command types are `order.place`, `order.modify`, `order.cancel` and `position.close`.

**How the EA treats commands:**
* It runs each command **at most once**: the command id is written to a file before execution.
* It never runs a command after its deadline.
* It writes the command id into the order comment, so reconciliation can match the order even when the report
  is lost.
* With no report within 15 s (market) or 30 s (pending), the order becomes `UNKNOWN` and is never re-sent.

**Exness:**
* Exness MT5 accounts can use this bridge when EAs and WebRequest are allowed on the account type.
* Exness also documents an API for "Exness trading accounts". That documentation could not be retrieved, so no
  direct adapter was written.
* Exness (KE) Limited states it is licensed by Kenya's CMA. Confirm your own eligibility and account terms
  directly with Exness.

---

## Provider evaluation

| Provider | Status | Notes |
|---|---|---|
| Deriv (Options/Multipliers) | Implemented (mock-tested) | OAuth/PAT, demo + real. Kenya eligibility **unverified**: check Deriv's restricted-country list |
| MT5 via AfeyFX Bridge | Implemented (mock-tested; EA not compiled in CI) | Any MT5 broker allowing EAs + WebRequest |
| Exness API (direct) | Not integrated | Docs unreachable; API limited to "Exness trading accounts"; use the MT5 bridge |
| OANDA | Platform routing only | Used for prices and admin routing; per-user OANDA connections not built |

AfeyFX does not assume a provider accepts Kenyan customers just because its site loads from Kenya. Do not use VPNs
or false details to get around a broker's restrictions.

## Verification checklist (before relying on an integration)

**Deriv**
- [ ] Register the app and connect a **demo** account via OAuth.
- [ ] **Test** passes and the capability is recorded as `verifiedOn: demo`.
- [ ] Instruments load; a quote appears in the order ticket.
- [ ] Preview a Multiplier order. Place a minimum-stake demo order, then confirm the contract id in Deriv's
      statement.
- [ ] Close it, or let SL/TP hit. Check that the AfeyFX trade shows the same profit as Deriv's profit table.
- [ ] Place a Rise/Fall demo contract and confirm settlement at expiry.
- [ ] Disconnect the network mid-session. Check that it reconnects, re-subscribes and that no duplicate order is
      sent.

**MT5**
- [ ] Compile the EA, run it on a demo account, and confirm Test passes.
- [ ] Market order with SL; pending order; modify; cancel; partial and full close (these have no automated test
      yet).
- [ ] Stop the EA mid-order and confirm the order goes to `UNKNOWN` → breaker → reconciliation.

Only then consider `BROKER_USER_LIVE_ALLOWED=true` with `LIVE_TRADING_ENABLED=true`, starting with minimal size.

## Deployment checklist

- HTTPS only. Set `APP_URL` / `API_PUBLIC_URL` to the public origin; the Deriv redirect URL and the MT5 Bridge URL
  are derived from them.
- `deploy/nginx/afeyfx.conf` already has:
  - `location /api/bridge/mt5/` with a 512 kB body limit (the server accepts 512 kB for bridge requests),
  - `location = /api/brokers/deriv/callback` with `access_log off`, because the query string carries the code,
  - and the `/socket.io/` websocket proxy.
- `ENCRYPTION_KEY` must be set and backed up: broker tokens and terminal secrets are unreadable without it.
- Keep `LIVE_TRADING_ENABLED=false` and `BROKER_USER_LIVE_ALLOWED=false` until the checklist above is complete.
- The `broker-accounts` job reconciles every connected account each minute. Reconciliation also runs once at
  startup.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `#error=OAUTH_STATE_INVALID` after Deriv login | Link expired or opened in another browser; start again from the same browser |
| `ENVIRONMENT_MISMATCH` | The account is demo but the connection is real, or the reverse. Create a connection of the right type |
| MT5 `BRIDGE_CLOCK` | Terminal/VPS clock is off by more than 60 s; sync the clock |
| MT5 `BRIDGE_AUTH` / 401 | Wrong terminal id or secret (or rotated); update `secret.txt` |
| MT5 `ACCOUNT_MISMATCH` | The terminal switched to another login; create a new connection for it |
| Orders rejected `quote-fresh` | The EA isn't streaming that symbol; add it to `QuoteSymbols` |
| Account shows **HALTED** | Read the reason in Logs, check the broker platform, then **Resume** (refused while orders are UNKNOWN) |
| `UNKNOWN` order | Wait for reconciliation (≤1 min) or press **Sync**; check the broker platform |

## Incomplete / needs your input

- No integration has been run against a real Deriv or MT5 account (no credentials available during development).
- The MQL5 EA is a reference implementation that has not been compiled here.
- MT5 pending orders, modify, cancel, partial close and open-order sync have no automated tests yet.
- Deriv `contract_update` (changing SL/TP after purchase) is not implemented. A token refresh happens only if
  Deriv issues refresh tokens.
- There is no direct Exness API adapter and no per-user OANDA connection.
- Before real accounts are enabled, someone needs to make legal and compliance decisions on offering broker
  connections in your jurisdiction.
