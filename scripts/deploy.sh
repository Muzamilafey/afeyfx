#!/usr/bin/env bash
# Build, test and (re)start the app. Run as the app user from the repo root:
#   ./scripts/deploy.sh
# Refuses to deploy if any test fails.
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH=${BRANCH:-main}

git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "==> Server: install, typecheck, test, build"
( cd server && npm ci && npm run typecheck && npm test && npm run build )

echo "==> Client: install, test, build"
( cd client && npm ci && npm test && npm run build )
rsync -a --delete client/dist/ /var/www/afeyfx/client/

echo "==> Backup before restart"
./scripts/backup.sh

echo "==> (Re)start"
if pm2 describe afeyfx-server >/dev/null 2>&1; then
  pm2 reload ecosystem.config.cjs --env production --update-env
else
  pm2 start ecosystem.config.cjs --env production
fi
pm2 save
sleep 5
curl -fsS http://127.0.0.1:5000/health && echo " <- health OK"
echo "Deployed. The server always restarts in PAPER mode; LIVE must be re-activated by an admin."
