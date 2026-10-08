#!/usr/bin/env bash
# Encrypted MongoDB backup with rotation. Schedule via cron (see docs/OPERATIONS.md):
#   15 * * * * /opt/afeyfx/scripts/backup.sh >> /var/log/afeyfx/backup.log 2>&1
# Requires: mongodump, openssl. BACKUP_PASSPHRASE_FILE must contain the encryption passphrase.
set -euo pipefail
BACKUP_DIR=${BACKUP_DIR:-/var/backups/afeyfx}
RETENTION_DAYS=${RETENTION_DAYS:-14}
PASSFILE=${BACKUP_PASSPHRASE_FILE:-/etc/afeyfx/backup.pass}
ENV_FILE=${ENV_FILE:-$(dirname "$0")/../.env}
URI=${MONGODB_URI:-$(grep -E '^MONGODB_URI=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)}
: "${URI:?MONGODB_URI not set}"
[ -r "$PASSFILE" ] || { echo "Missing passphrase file $PASSFILE"; exit 1; }

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$BACKUP_DIR/afeyfx-$STAMP.archive.gz.enc"
umask 077
mongodump --uri="$URI" --archive --gzip | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASSFILE" -out "$OUT"
sha256sum "$OUT" > "$OUT.sha256"
find "$BACKUP_DIR" -name 'afeyfx-*.enc*' -mtime "+$RETENTION_DAYS" -delete
echo "$(date -u) backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
# Copy off-server (strongly recommended), e.g.:
# rclone copy "$OUT" remote:afeyfx-backups/ && rclone copy "$OUT.sha256" remote:afeyfx-backups/
