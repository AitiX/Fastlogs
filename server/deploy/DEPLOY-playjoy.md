# FastLogs - PlayJoy-specific deployment

This file holds the PlayJoy-internal specifics. The generic, reusable steps live
in [`INSTALL.md`](INSTALL.md) - follow that first, then apply the values below.

> Deploy to production only after explicit sign-off from the service owner.

## Target

| Item | Value |
|------|-------|
| Droplet (DigitalOcean) | `134.122.49.207` |
| Public domain | `fastlogs.playjoystudios.com` |
| System user | `fastlogs` |
| App dir | `/var/lib/fastlogs/app/server` |
| Data dir | `/var/lib/fastlogs/data` |
| Blob dir | `/var/lib/fastlogs/blobs` |
| Config | `/etc/fastlogs/fastlogs.env` |

Set in `/etc/fastlogs/fastlogs.env`:

```
BASE_URL=https://fastlogs.playjoystudios.com
```

nginx `server_name` and the certbot `-d` flag both use
`fastlogs.playjoystudios.com`:

```bash
certbot --nginx -d fastlogs.playjoystudios.com
```

## DNS

Add an A record: `fastlogs.playjoystudios.com -> 134.122.49.207`.

## Migration from the old deploy

The previous server lived under the local working copy
`D:\Other\UnityWebServer`. To migrate:

1. Stand up FastLogs alongside the old service (different port / path) and verify
   `/api/health` and an end-to-end ingest with a test app.
2. Re-register the production apps with `scripts/add-app.js` (ingest tokens are
   minted fresh - mint new tokens and roll them into the Unity/GameMaker client
   configs; the old hashes are not portable).
3. If old log blobs/links must be preserved, copy them into the new
   `/var/lib/fastlogs/{data,blobs}` layout; otherwise start clean and let the
   old links expire.
4. Switch DNS / nginx `server_name` to point `fastlogs.playjoystudios.com` at the
   new service, then decommission the old `UnityWebServer` deploy.

---

## Rotate the exposed root key (dossh) - REQUIRED

The old `dossh` root key was exposed and MUST be rotated. Do this before or as
part of bringing the droplet under the new deploy model.

1. **Create a dedicated deploy user without root** (if not already done per
   INSTALL.md step 2). The deploy user gets scoped sudo only:
   ```bash
   # /etc/sudoers.d/deploy-fastlogs
   deploy ALL=(fastlogs) NOPASSWD: /usr/bin/node, /usr/bin/npm
   deploy ALL=(root)     NOPASSWD: /bin/systemctl restart fastlogsd
   ```

2. **Generate a new ed25519 key WITH a passphrase** on the dev machine (do not
   reuse the old passphrase-less key):
   ```bash
   ssh-keygen -t ed25519 -C "deploy@fastlogs-playjoy" -f ~/.ssh/deploy_fastlogs
   ```

3. **Install the new public key** for the deploy user on the droplet:
   ```bash
   # On 134.122.49.207, as root (last time over the old key) or via console:
   echo "<new deploy pubkey>" >> /home/deploy/.ssh/authorized_keys
   chmod 600 /home/deploy/.ssh/authorized_keys
   chown deploy:deploy /home/deploy/.ssh/authorized_keys
   ```

4. **Verify** the new key + deploy user work end to end:
   ```bash
   ssh -i ~/.ssh/deploy_fastlogs deploy@fastlogs.playjoystudios.com "echo ok"
   ./deploy/deploy.sh deploy@fastlogs.playjoystudios.com   # dry-run on staging first
   ```

5. **Remove the exposed dossh root key.** Delete it from
   `/root/.ssh/authorized_keys` on the droplet AND delete the local copy from the
   dev machine:
   ```bash
   # On the droplet:
   sed -i '/dossh/d' /root/.ssh/authorized_keys   # or edit out the exact line
   ```

6. **Lock down root SSH.** In `/etc/ssh/sshd_config`:
   ```
   PermitRootLogin prohibit-password
   ```
   Then `systemctl restart ssh`. After this, root cannot log in by password and
   the exposed key is gone; all deploys go through the unprivileged `deploy` user
   with scoped sudo.

7. **Secrets** (ADMIN_TOKEN, VIEWER_TOKEN, IP_SALT) stay in
   `/etc/fastlogs/fastlogs.env`, never in the repo.
