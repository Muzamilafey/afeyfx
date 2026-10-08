#!/usr/bin/env bash
# One-time hardening + dependency install for Ubuntu 22.04/24.04. Run as root:
#   sudo DOMAIN=trading.example.com EMAIL=you@example.com ./scripts/setup-vps.sh
set -euo pipefail
: "${DOMAIN:?set DOMAIN}"
: "${EMAIL:?set EMAIL}"
APP_USER=${APP_USER:-afeyfx}
APP_DIR=${APP_DIR:-/opt/afeyfx}

apt-get update
apt-get -y upgrade
apt-get install -y curl git ufw fail2ban nginx certbot python3-certbot-nginx chrony unattended-upgrades gnupg

# Time sync matters: exchanges reject requests with clock drift.
systemctl enable --now chrony

# Firewall: only SSH and HTTPS/HTTP. MongoDB (27017) and the API (5000) are NOT exposed.
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# SSH hardening (ensure you have key-based access BEFORE running this)
sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
systemctl reload ssh || systemctl reload sshd
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g pm2

# MongoDB 7 (bound to localhost; auth enabled after the admin user is created - see docs/DEPLOYMENT.md)
curl -fsSL https://www.mongodb.org/static/pgp/server-7.0.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-7.0.gpg
. /etc/os-release
echo "deb [ signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu ${VERSION_CODENAME}/mongodb-org/7.0 multiverse" > /etc/apt/sources.list.d/mongodb-org-7.0.list
apt-get update && apt-get install -y mongodb-org
systemctl enable --now mongod

# App user and directories
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
mkdir -p "$APP_DIR" /var/www/afeyfx/client /var/log/afeyfx /var/backups/afeyfx
chown -R "$APP_USER:$APP_USER" "$APP_DIR" /var/log/afeyfx /var/backups/afeyfx /var/www/afeyfx
chmod 700 /var/backups/afeyfx

# Nginx + TLS
cp "$(dirname "$0")/../deploy/nginx/afeyfx-proxy.conf" /etc/nginx/snippets/afeyfx-proxy.conf
sed "s/trading.example.com/${DOMAIN}/g" "$(dirname "$0")/../deploy/nginx/afeyfx.conf" > /etc/nginx/sites-available/afeyfx.conf
ln -sf /etc/nginx/sites-available/afeyfx.conf /etc/nginx/sites-enabled/afeyfx.conf
rm -f /etc/nginx/sites-enabled/default
mkdir -p /var/www/certbot
# Obtain the certificate with a temporary HTTP-only config
certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive || certbot certonly --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive
nginx -t && systemctl reload nginx
cp "$(dirname "$0")/../deploy/logrotate-afeyfx" /etc/logrotate.d/afeyfx

# PM2 on boot for the app user
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$APP_USER" --hp "/home/$APP_USER"
echo "Done. Next: follow docs/DEPLOYMENT.md (MongoDB auth, .env, deploy.sh)."
