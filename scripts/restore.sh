#!/usr/bin/env bash
# Restore an encrypted backup. STOP THE APP FIRST: pm2 stop afeyfx-server
#   ./scripts/restore.sh /var/backups/afeyfx/afeyfx-20260101T000000Z.archive.gz.enc
set -euo pipefail
FILE=${1:?backup file}
PASSFILE=${BACKUP_PASSPHRASE_FILE:-/etc/afeyfx/backup.pass}
ENV_FILE=${ENV_FILE:-$(dirname "$0")/../.env}
URI=${MONGODB_URI:-$(grep -E '^MONGODB_URI=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)}
sha256sum -c "$FILE.sha256"
if pm2 describe afeyfx-server 2>/dev/null | grep -q online; then echo "Stop the app first (pm2 stop afeyfx-server)"; exit 1; fi
read -r -p "This will DROP and replace the current database. Type RESTORE to continue: " ok
[ "$ok" = "RESTORE" ] || exit 1
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASSFILE" -in "$FILE" | mongorestore --uri="$URI" --archive --gzip --drop
echo "Restored. Start the app (PAPER mode), then run reconciliation before any LIVE activity."
