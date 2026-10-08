# Security

## Controls implemented

| Area | Implementation |
|---|---|
| Passwords | bcrypt (cost 12). At least 12 characters with upper case, lower case and a digit. Accounts lock for 15 minutes after 5 failed logins. Login errors are generic and response timing is equalized. |
| Sessions | Short-lived JWT access token (15 min, HS256, issuer-checked), kept **in memory only** in the browser. The refresh token is an **httpOnly, Secure, SameSite=Strict** cookie scoped to `/api/auth`, stored hashed, and **rotated** on every use. If a rotated token is reused, the whole session family is revoked. |
| 2FA | TOTP (RFC 6238), implemented on `node:crypto` and tested against the RFC 4226 vectors. The secret is encrypted at rest. A 2FA login issues a 5-minute challenge token that can't be used as an access token. |
| Email verification | Single-use 24-hour links, stored as HMAC (never in plaintext). Trading and admin actions require a verified email (`REQUIRE_EMAIL_VERIFICATION`). The verified flag travels in the access token, and a refresh picks it up. |
| Email codes (2FA) | 6-digit codes generated with `crypto.randomInt`, stored as an HMAC that is **purpose-bound** (a login code can't confirm an action), valid for 10 minutes, **single-use** (consumed atomically, so a replay fails), invalidated after 5 wrong attempts, with a 30-second resend cooldown. They go only to a verified address. Enabling them requires proving access to the inbox. |
| Social sign-in | Google (OpenID Connect, authorization-code flow, ID token verified with `google-auth-library` against the client ID) and GitHub (OAuth web flow; only the **primary + verified** email is accepted). An httpOnly CSRF state cookie is bound to the provider and compared in constant time. The session is handed over through the refresh cookie and is never put in the URL. A pending 2FA challenge travels only in the URL fragment. Accounts are linked by provider id or by a provider-verified email, a mismatched link is refused, and **2FA is never bypassed**. |
| Portals | `/admin/login` accepts only admin accounts, enforced server-side with a generic error. Traders and admins each have their own UI. |
| Tenant isolation | Personal demo portfolios, positions, orders and trades are scoped by owner in every query. System-book endpoints are admin-only and exclude personal accounts by default. Socket.IO account events go only to their owner's room. |
| RBAC | `viewer` < `trader` < `admin`. Viewers have read-only access. Traders can run backtests, trade paper and manage paper positions. Admins can change configuration, live mode, emergency controls, users and keys. Denials are audited. |
| Protected actions | Live preflight and enablement, the four emergency controls, risk limits, circuit-breaker resets, strategy stage changes, version reviews and exchange keys all need an admin with 2FA **plus a fresh TOTP code** on each request, with a strict rate limit. Enabling live also needs the password and a typed confirmation phrase. |
| Exchange keys | AES-256-GCM encrypted at rest (`ENCRYPTION_KEY`, 32 bytes) and never selected by default or serialized. The browser only ever sees the last 4 characters. Permissions are verified on submission, and keys that can **withdraw or transfer are rejected**. |
| Withdrawals | No adapter method exists for them. The CCXT client is wrapped in a Proxy that throws on any `withdraw*` or `transfer*` property (unified and implicit endpoints). A source scan test fails if any such call is added. |
| Live trading | Env kill switch (`LIVE_TRADING_ENABLED`, exact value `true` only) **plus** admin activation **plus** breaker state, checked in `LiveTradingGuard` (execution service) **and** inside `CcxtAdapter.createOrder`. The app always restarts in PAPER. |
| AI | Claude gets no tools and no access to execution or exchange modules. Its output is schema-validated, and a symbol mismatch or invalid output is discarded. News text is treated as untrusted data. It can only veto. |
| Transport | HTTPS through Nginx (TLS 1.2/1.3, HSTS). The API binds to `127.0.0.1`. The Socket.IO handshake needs an access token. |
| Headers | helmet (API), strict CSP and other security headers (Nginx/SPA), no `x-powered-by`. |
| CORS | Allow-list taken from `CLIENT_ORIGIN`, with credentials. |
| Rate limiting | Express rate limits (API, auth, protected actions) and Nginx `limit_req`. |
| Input validation | zod schemas on every mutating endpoint, a 100 KB JSON limit, and symbol and timeframe allow-lists. |
| Secrets in logs | pino redaction paths plus `redactSecrets()` on every free-form error string and every Telegram message. Telegram errors never include the bot token. |
| Audit | Append-only `AuditLog` (update and delete hooks throw). Logins, 2FA, RBAC denials, config changes, keys, live mode and emergency actions are all recorded, with secret-looking fields redacted. |
| Database | MongoDB bound to localhost with auth enabled (see DEPLOYMENT.md) and never exposed by the firewall. |
| Production config | The server refuses to start if the JWT secrets are shorter than 32 characters or `ENCRYPTION_KEY` isn't 64 hex characters. |

## Exchange API key requirements

Create keys with **trading enabled**, **withdrawals disabled**, **transfers disabled** and an **IP restriction to the
VPS IP**. On Binance, use spot trading only. On Bybit, don't grant Wallet/Withdraw. On Coinbase, don't grant
`transfer`. The platform rejects keys that fail these rules.

## Security audit (phase 13): findings and status

| # | Finding | Status |
|---|---|---|
| 1 | `npm audit --omit=dev` (server and client) | 0 known vulnerabilities at the time of writing. CI fails on high or above. |
| 2 | Live order path reachable without the env switch? | No. Covered by `liveTradingProtection.test.ts` at the guard, adapter, execution and API levels. |
| 3 | Withdrawal endpoints reachable? | No. Covered by `withdrawals.test.ts` (Proxy guard, interface, source scan, permission flags, preflight). |
| 4 | Secrets exposed to the browser or logs | The credentials list returns masked hints only. Logs and Telegram are redacted. Tests cover serialization and redaction. |
| 5 | Unauthenticated access to private endpoints | Every private route sits behind `requireAuth`. A test iterates the endpoints and expects 401. |
| 6 | Forged / `alg:none` JWT | Rejected (algorithm pinned to HS256 and issuer checked). Tested. |
| 7 | CSRF | API mutations use Bearer tokens, not cookies. The refresh cookie is SameSite=Strict and path-scoped. |
| 8 | TOTP replay inside its validity window (±30 s) | Email codes are single-use. Authenticator codes: **accepted risk**. Replaying a code also needs a valid access token. Per-counter replay blocking was left out because it would block an admin who logs in with 2FA and immediately triggers an emergency action. Revisit if the threat model changes. |
| 9 | Bootstrap registration race (two "first" users) | Low risk. In production, create the admin with `npm run create-admin` before exposing the site. |
| 11 | Auth rate limiter counted session refreshes, so normal browsing hit the limit (found in UI testing) | Fixed: credential endpoints count only failed attempts, and refresh/OAuth redirects have their own generous limiter. |
| 12 | Admin system-book lists included traders' personal demo positions (found in UI testing) | Fixed: lists default to the system book (`owner=all` is explicit). Covered by a test. |
| 13 | Starting authenticator setup silently disabled an active authenticator | Fixed: re-enrolment requires disabling it first (with a code). |
| 14 | Chart crashed in dark mode (Tailwind `oklch()` colours unsupported by the chart library) | Fixed: explicit hex chart colours per theme. |
| 10 | Single-process jobs | Required for correctness. PM2 is configured with `instances: 1`, fork mode. |

## Reporting

Report suspected vulnerabilities privately to the repository owner. Never post exchange keys in issues.
