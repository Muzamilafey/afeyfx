# Operations runbook

## Monitoring

| What | How |
|---|---|
| Liveness | `GET /health` (public, minimal) returns 200 when MongoDB is connected and 503 otherwise. |
| Component health | `GET /api/system/health` (authenticated) covers database ping, market data age, exchange WebSocket, trading engine last scan, risk-engine self-test, AI, Socket.IO clients, breaker state and memory. It is shown in Admin → Controls. |
| External watchdog | `scripts/healthcheck.sh` from cron every minute. It sends Telegram alerts on failure and recovery. |
| Process | `pm2 status`, `pm2 logs afeyfx-server`, `pm2 monit`. Logs are structured JSON (pino) in `/var/log/afeyfx/`. |
| Trading alerts | Telegram covers trade opened/closed, stop loss, take profit, large loss (≥50% of the daily limit), daily loss limit, strategy disabled, exchange disconnected, API failure (breaker), reconciliation mismatch, emergency shutdown and live mode enabled/disabled. |
| Errors | Admin → Logs → Errors (job failures), Risk events, Audit log. |

Recommended crontab for the `afeyfx` user:

```
* * * * *   /opt/afeyfx/scripts/healthcheck.sh >> /var/log/afeyfx/healthcheck.log 2>&1
15 * * * *  /opt/afeyfx/scripts/backup.sh      >> /var/log/afeyfx/backup.log 2>&1
```

Things to review daily: breaker trips, rejected-signal reasons (Trades → Signals), reconciliation events,
paper vs live drift, fees and slippage relative to backtest assumptions.

## Backups

* `scripts/backup.sh` runs `mongodump`, gzips and encrypts it with AES-256 (PBKDF2, passphrase in
  `/etc/afeyfx/backup.pass`, mode 600), writes a sha256 checksum and keeps 14 days of backups. **Copy the backups off the server**
  (rclone or S3; an example is in the script).
* `scripts/deploy.sh` takes a backup before every restart.
* Store `.env` (particularly `ENCRYPTION_KEY`) separately and securely. Without it, the stored exchange keys and 2FA
  secrets can't be decrypted.
* **Restore:** `pm2 stop afeyfx-server` → `./scripts/restore.sh <file>` → start → the app comes up in PAPER → check
  Admin → Controls → health → if you trade live, reconcile against the exchange before re-activating.
* Test a restore into a scratch database every month.

## Emergency shutdown procedure

The dashboard has **four separate controls** (Admin → Controls). Each needs a fresh 2FA code:

| Control | Effect | Use when |
|---|---|---|
| **Stop new trades** | Blocks new entries. SL/TP and exits keep working. | Something looks wrong but positions are fine |
| **Cancel open orders** | Cancels every resting order in the current mode | A runaway or erroneous order |
| **Close all positions** | Market-closes every open position | You need to be flat (slippage is likely) |
| **Emergency shutdown** | Stops new trades, halts the engine, cancels orders and switches LIVE off (→ PAPER). Positions are **not** closed. | Serious malfunction, a compromise, or exchange problems |

**Procedure:**

1. Click **Emergency shutdown** and give a reason. Telegram confirms it.
2. Decide whether to flatten. If so, click **Close all positions** (or close them manually on the exchange).
3. If the dashboard or server can't be reached, SSH in and run `./scripts/emergency-stop.sh`. It forces
   `LIVE_TRADING_ENABLED=false` and stops the process. **Exchange-side protective stop orders stay active.**
4. If you suspect a compromise, revoke the API key **on the exchange website** first. That is the fastest kill
   switch and doesn't depend on this server.
5. Check open orders and positions directly on the exchange.
6. Investigate using the audit log, risk events, logs and the trade trace.
7. Recover: **Clear emergency**, fix the cause, reset the breaker trips, then **Resume trading** (paper first).

## Enabling LIVE trading (checklist)

Only an admin can do this, and only on purpose:

1. The strategy has completed: backtest → walk-forward out-of-sample → ≥30 paper trades with acceptable
   drawdown, fees and slippage → human **APPROVED** → stage **LIVE** (each step is protected by 2FA).
2. The exchange key has trading enabled, withdrawals and transfers disabled, and an IP restriction. Start on testnet.
3. Set conservative risk limits (the defaults are 0.5% per trade, 2% daily, 5% weekly, 5 positions, 20% exposure, 1x leverage).
4. On the server, set `LIVE_TRADING_ENABLED=true` in `.env` and restart (the app still comes up in PAPER).
5. Admin → Live mode → **Run preflight**. All checks must pass: env switch, credentials, trade permission, withdrawals
   disabled, market data, risk bounds, balance, clock drift ≤ 1 s, exchange status, breaker clear, a LIVE strategy.
6. Within 5 minutes, click **Enable LIVE trading**, then enter your password, a 2FA code and the confirmation phrase.
7. Watch the first trades closely. Reconciliation runs every 2 minutes and stops new trades if it finds a mismatch.

To leave LIVE, use **Switch back to PAPER** (no 2FA needed, because it is always safe), set
`LIVE_TRADING_ENABLED=false`, and restart.
