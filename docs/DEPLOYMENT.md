# Production deployment (Linux VPS · Nginx · PM2 · HTTPS)

```
Internet ─▶ Nginx :443 (TLS, static React, rate limits) ─▶ Express API + trading engine :5000 (127.0.0.1, PM2)
                                                                   └─▶ MongoDB :27017 (127.0.0.1, auth) ─▶ Exchange APIs
```

## 1. Server

* Ubuntu 22.04 or 24.04, 2 vCPU / 4 GB RAM minimum, SSD. Pick a region with low latency to your exchange.
* A DNS A record for your domain (e.g. `trading.example.com`) pointing at the VPS.
* SSH key access for a sudo user. The setup script disables password and root SSH logins.

```bash
git clone <repo> /opt/afeyfx && cd /opt/afeyfx
sudo DOMAIN=trading.example.com EMAIL=you@example.com ./scripts/setup-vps.sh
```

The script installs Node 22, PM2, MongoDB 7, Nginx, certbot, chrony (time sync), fail2ban and unattended upgrades. It
sets UFW to allow only SSH, HTTP and HTTPS, creates the `afeyfx` user and directories, and installs the Nginx site and TLS certificate.

## 2. MongoDB hardening

```bash
mongosh <<'EOF'
use admin
db.createUser({ user: "root", pwd: passwordPrompt(), roles: ["root"] })
use afeyfx
db.createUser({ user: "afeyfx", pwd: passwordPrompt(), roles: [{ role: "readWrite", db: "afeyfx" }] })
EOF
sudo cp deploy/mongod.conf /etc/mongod.conf   # bindIp 127.0.0.1 + authorization: enabled
sudo systemctl restart mongod
```

Then set `MONGODB_URI=mongodb://afeyfx:<password>@127.0.0.1:27017/afeyfx?authSource=afeyfx`.
Never open port 27017 in the firewall or a cloud security group.

## 3. Configuration

```bash
sudo chown -R afeyfx:afeyfx /opt/afeyfx && sudo -iu afeyfx
cd /opt/afeyfx
cp .env.example .env && chmod 600 .env
./scripts/generate-secrets.sh     # paste JWT_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY into .env
```

Set at least the following: `NODE_ENV=production`, `CLIENT_ORIGIN=https://trading.example.com`, `MONGODB_URI`, the secrets,
`COOKIE_SECURE=true`, and the optional `ANTHROPIC_API_KEY`, `AI_ENABLED`, `TELEGRAM_*` and exchange keys
(or add the keys later in Admin → Exchanges). **Keep `LIVE_TRADING_ENABLED=false`.**

Use a secrets manager if you have one (e.g. SOPS or Vault-rendered `.env`, or systemd credentials). At minimum,
the `.env` must be `chmod 600`, owned by the app user, and excluded from backups that leave the server unencrypted.

## 4. Deploy

```bash
./scripts/deploy.sh              # installs, typechecks, runs ALL tests, builds, backs up, starts PM2
npm --prefix server run create-admin -- you@example.com "Your Name"
```

`deploy.sh` stops if any test fails. PM2 uses `ecosystem.config.cjs`: fork mode, a single instance, memory
restart and exponential backoff. Logs go to `/var/log/afeyfx` and are rotated daily.

Next steps:

1. Sign in, enable **2FA**, and create trader or viewer accounts as needed.
2. Import history, run backtests and walk-forward tests, then paper trade.
3. Set up cron jobs for backups and health checks (see OPERATIONS.md).

## 5. Nginx and HTTPS

* `deploy/nginx/afeyfx.conf`: HTTP→HTTPS redirect, TLS 1.2/1.3, HSTS, CSP, rate-limit zones for `/api`
  and `/api/auth`, WebSocket upgrade for `/socket.io`, and long-lived caching for hashed assets.
* Certificates renew automatically through certbot's systemd timer. Check with `sudo certbot renew --dry-run`.
* Optional: restrict the dashboard to your IPs or a VPN using the commented `allow`/`deny` block.

## 6. Updating

```bash
sudo -iu afeyfx && cd /opt/afeyfx && ./scripts/deploy.sh
```

A restart always comes back in **PAPER** mode. If you were trading live, follow the live re-activation checklist
in OPERATIONS.md.

## Free HTTPS without buying a domain (sslip.io)

M-Pesa (and Google/GitHub sign-in) work best on HTTPS. If you only have the server's IP address, use a free
`sslip.io` name: `167-86-67-201.sslip.io` resolves to `167.86.67.201` automatically, and Let's Encrypt issues a
certificate for it. Replace the IP with your own (dots become dashes).

```bash
HOST=167-86-67-201.sslip.io        # <- your IP with dashes
sudo sed "s/listen 14000;/listen 80;/; s/server_name _;/server_name $HOST;/" \
  /etc/nginx/sites-available/afeyfx-14000 | sudo tee /etc/nginx/sites-available/afeyfx-sslip > /dev/null
sudo ln -sf /etc/nginx/sites-available/afeyfx-sslip /etc/nginx/sites-enabled/
sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d $HOST --redirect

cd /var/www/afeyfx
sed -i "s|^APP_URL=.*|APP_URL=https://$HOST|; s|^CLIENT_ORIGIN=.*|CLIENT_ORIGIN=https://$HOST,http://167.86.67.201:14000|; s|^COOKIE_SECURE=.*|COOKIE_SECURE=true|" .env
grep -q '^API_PUBLIC_URL=' .env && sed -i "s|^API_PUBLIC_URL=.*|API_PUBLIC_URL=https://$HOST|" .env || echo "API_PUBLIC_URL=https://$HOST" >> .env
pm2 restart afeyfx-server --update-env
curl https://$HOST/health
```

Then use `https://167-86-67-201.sslip.io` (the plain `http://IP:14000` address keeps working for viewing, but
sign-in cookies are HTTPS-only once `COOKIE_SECURE=true`). If `API_PUBLIC_URL` is also set in Admin → Integrations,
update it there too (console values override `.env`). `nip.io` works the same way if sslip.io is unavailable.

On plain http, deposits still work when Daraja accepts the callback URL: the server confirms every pending deposit
by asking M-Pesa directly (STK Push Query) every 15 seconds, so a missing callback only delays confirmation.
Withdrawal results arrive only by callback, so use HTTPS before enabling withdrawals.
