#!/usr/bin/env bash
# Out-of-band emergency stop for when the dashboard is unreachable.
#   ./scripts/emergency-stop.sh
# 1) forces LIVE_TRADING_ENABLED=false in .env (hard kill switch)
# 2) stops the server process (no new orders of any kind can be sent)
# Exchange-side protective stop orders placed for LIVE positions REMAIN ACTIVE on the exchange.
# Review open positions/orders directly on the exchange website afterwards.
set -euo pipefail
ENV_FILE=${ENV_FILE:-$(dirname "$0")/../.env}
if grep -q '^LIVE_TRADING_ENABLED=' "$ENV_FILE"; then
  sed -i 's/^LIVE_TRADING_ENABLED=.*/LIVE_TRADING_ENABLED=false/' "$ENV_FILE"
else
  echo 'LIVE_TRADING_ENABLED=false' >> "$ENV_FILE"
fi
pm2 stop afeyfx-server || true
echo "$(date -u) EMERGENCY STOP: process stopped, LIVE_TRADING_ENABLED=false" | tee -a /var/log/afeyfx/emergency.log
echo "Check open orders/positions on the exchange. Restart later with: pm2 start ecosystem.config.cjs --env production (starts in PAPER)."
