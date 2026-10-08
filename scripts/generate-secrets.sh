#!/usr/bin/env bash
# Print fresh random secrets for .env (paste them in; never commit them).
set -euo pipefail
echo "JWT_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48 | tr -d '\n')"
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
