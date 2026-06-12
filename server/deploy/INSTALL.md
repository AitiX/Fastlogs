# FastLogs - generic server installation

This guide sets up FastLogs on any VPS with systemd, nginx, and Node. For a
container-based deploy see `server/Dockerfile` and `server/docker-compose.yml`
(run `docker compose up -d` after filling in `.env`).

Replace `your-domain.example` everywhere with your real domain.

## Prerequisites

- A Linux host with systemd (Ubuntu 22.04+ or similar)
- Node.js >= 18 (`apt install nodejs` or use `nvm`)
- nginx
- certbot

---

## 1. System user

```bash
useradd --system --create-home --home-dir /var/lib/fastlogs --shell /usr/sbin/nologin fastlogs
chmod 700 /var/lib/fastlogs
```

## 2. Deploy user (SSH-only, no root)

Create a deploy user that can rsync source files and restart only the FastLogs
service. The deploy user has NO root access.

```bash
useradd --system --create-home --shell /bin/bash deploy
mkdir -p /home/deploy/.ssh
# Paste the deploy SSH public key:
nano /home/deploy/.ssh/authorized_keys
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
```

Scope the deploy user's sudo to exactly what a deploy needs:

```bash
# /etc/sudoers.d/deploy-fastlogs
deploy ALL=(fastlogs) NOPASSWD: /usr/bin/node, /usr/bin/npm
deploy ALL=(root)     NOPASSWD: /bin/systemctl restart fastlogsd
```

## 3. App and data directories

```bash
mkdir -p /var/lib/fastlogs/app
chown fastlogs:fastlogs /var/lib/fastlogs/app

mkdir -p /var/lib/fastlogs/data /var/lib/fastlogs/blobs
chown fastlogs:fastlogs /var/lib/fastlogs/data /var/lib/fastlogs/blobs
chmod 750 /var/lib/fastlogs/data /var/lib/fastlogs/blobs
```

Sync the repository's `server/` tree into `/var/lib/fastlogs/app/server`
(`./deploy/deploy.sh fastlogs@your-domain.example` does this for you), then:

```bash
cd /var/lib/fastlogs/app/server && npm ci --omit=dev
```

## 4. Config file

```bash
mkdir /etc/fastlogs
cp /var/lib/fastlogs/app/server/.env.example /etc/fastlogs/fastlogs.env
chmod 640 /etc/fastlogs/fastlogs.env
chown root:fastlogs /etc/fastlogs/fastlogs.env
# Fill in ADMIN_TOKEN, VIEWER_TOKEN, IP_SALT, BASE_URL (https://your-domain.example), etc.
# Point DATA_DIR and BLOB_DIR at /var/lib/fastlogs/data and /var/lib/fastlogs/blobs.
nano /etc/fastlogs/fastlogs.env
```

## 5. systemd units

```bash
cp /var/lib/fastlogs/app/server/deploy/fastlogsd.service          /etc/systemd/system/
cp /var/lib/fastlogs/app/server/deploy/fastlogs-sweeper.service   /etc/systemd/system/
cp /var/lib/fastlogs/app/server/deploy/fastlogs-sweeper.timer     /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now fastlogsd
systemctl enable --now fastlogs-sweeper.timer
```

## 6. nginx reverse proxy

```bash
cp /var/lib/fastlogs/app/server/deploy/nginx-fastlogs.conf \
   /etc/nginx/sites-available/your-domain.example
# Edit the file and replace your-domain.example with your domain.
ln -s /etc/nginx/sites-available/your-domain.example \
      /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```

## 7. TLS with certbot

```bash
certbot --nginx -d your-domain.example
```

## 8. DNS

Add an A record: `your-domain.example -> <server IP>`

## 9. Register the first app

```bash
sudo -u fastlogs node /var/lib/fastlogs/app/server/scripts/add-app.js mygame "My Game" 30
# Prints the ingest token once - store it in the game client config.
```

## 10. Sinks (optional forwarding)

On each successful ingest the server can forward a small payload (see
`../../CONTRACT.md` section 5) to Slack / Discord / a generic webhook / etc.

```bash
cp /var/lib/fastlogs/app/server/config/sinks.example.json \
   /var/lib/fastlogs/app/server/config/sinks.json
# Fill in real webhook URLs. Per-app overrides live in apps.sinks_json.
```

---

## SSH key rotation (deploy key)

1. Generate a new ed25519 key pair on the dev machine (WITH a passphrase):
   ```bash
   ssh-keygen -t ed25519 -C "deploy@fastlogs" -f ~/.ssh/deploy_fastlogs_new
   ```

2. Add the NEW public key to the server:
   ```bash
   # On the server (as root or the deploy user):
   echo "<new pubkey>" >> /home/deploy/.ssh/authorized_keys
   ```

3. Verify the new key works:
   ```bash
   ssh -i ~/.ssh/deploy_fastlogs_new deploy@your-domain.example "echo ok"
   ```

4. Remove the OLD public key from `/home/deploy/.ssh/authorized_keys`.

5. Delete the old key pair from the dev machine.

**Rules:**
- The deploy user has NO root access. sudo is scoped to only
  `systemctl restart fastlogsd` and running node/npm as the `fastlogs` user.
- Set `PermitRootLogin prohibit-password` in `/etc/ssh/sshd_config`.
- Secrets (ADMIN_TOKEN, VIEWER_TOKEN, IP_SALT) stay in
  `/etc/fastlogs/fastlogs.env`, never in the repo.
