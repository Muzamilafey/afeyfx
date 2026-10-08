#!/usr/bin/env bash
# External watchdog (cron every minute). Alerts via Telegram if the API is down.
#   * * * * * /opt/afeyfx/scripts/healthcheck.sh >> /var/log/afeyfx/healthcheck.log 2>&1
set -uo pipefail
ENV_FILE=${ENV_FILE:-$(dirname "$0")/../.env}
TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
CHAT=$(grep -E '^TELEGRAM_CHAT_ID=' "$ENV_FILE" | cut -d= -f2-)
STATE=/tmp/afeyfx-health.state
if body=$(curl -fsS --max-time 10 http://127.0.0.1:5000/health); then
  [ -f "$STATE" ] && rm -f "$STATE" && msg="✅ AfeyFX API recovered: $body"
else
  if [ ! -f "$STATE" ]; then touch "$STATE"; msg="🚨 AfeyFX API health check FAILED on $(hostname) at $(date -u)"; fi
fi
if [ -n "${msg:-}" ] && [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
  curl -fsS --max-time 10 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" -d chat_id="$CHAT" --data-urlencode text="$msg" >/dev/null || true
fi
echo "$(date -u) ${msg:-ok}"
