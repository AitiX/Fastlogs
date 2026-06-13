# FastLogs server

Node.js HTTP server behind nginx. Receives logs from game clients (Unity, GameMaker), stores them, and serves a web viewer with a short link.

Dependency-light (only `better-sqlite3`) and reusable: the defaults are neutral
(`BASE_URL=http://localhost:8787`), so any team can deploy it under their own
domain. The license is MIT (see the repo root `LICENSE`) - swap it freely.

## Quick start

```bash
cd server
cp .env.example .env        # Fill in ADMIN_TOKEN, VIEWER_TOKEN, IP_SALT, etc.
npm install
npm run add-app -- lfa "Looking For Aliens" 30
npm start
```

## Scripts

| Command | What it does |
|---------|-------------|
| `npm start` | Start the server (`src/server.js`) |
| `npm test` | Run all tests (`test/run.js`) |
| `npm run sweep` | Delete expired logs (call from cron / systemd timer) |
| `npm run add-app -- <appId> "<name>" [days]` | Register or update an app; prints its ingest token |
| `npm run migrate` | Apply DB migrations (also done automatically on start) |

## Environment variables

See `.env.example` for inline docs. Full list:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8787` | HTTP listen port (nginx proxies here) |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` in Docker (the published port is mapped to host loopback only) |
| `BASE_URL` | `http://localhost:8787` | Public base URL for short links (set to your real URL in production) |
| `DATA_DIR` | `./data` | SQLite DB directory |
| `BLOB_DIR` | `./blobs` | Log body (gzip) + screenshot storage |
| `DEFAULT_RETENTION_DAYS` | `30` | Default log lifetime (days) when an app has no own setting |
| `MAX_RETENTION_DAYS` | `365` | Hard ceiling for retention; all values clamped to this |
| `SWEEP_INTERVAL_SEC` | `3600` | How often expired (non-pinned) logs are purged. `0` disables the in-process sweep |
| `SWEEP_BATCH` | `500` | Max logs deleted per sweep pass |
| `MAX_PAYLOAD_BYTES` | `8388608` | Max whole request body (~8 MB) |
| `MAX_SCREENSHOT_BYTES` | `2097152` | Max decoded PNG screenshot (~2 MB) |
| `MAX_LOG_BYTES` | `20971520` | Max decompressed log text (~20 MB) |
| `ADMIN_TOKEN` | _(none)_ | Admin: delete, manage apps (and unpin when `UNPIN_REQUIRES_ADMIN=1`). Empty disables admin auth (dev) |
| `VIEWER_TOKEN` | _(none)_ | Team viewer token for the catalog `/browse`. Empty CLOSES the catalog (fail-closed): `/browse` returns 401 for everyone except the admin token |
| `TEAM_INGEST_TOKEN` | _(none)_ | Shared master ingest token valid for ANY app (one secret instead of per-app tokens) |
| `ALLOW_AUTO_REGISTER` | `0` | With the team token, an unknown `appId` self-registers (tokenless) on first ingest. Requires `TEAM_INGEST_TOKEN` |
| `UNPIN_REQUIRES_ADMIN` | `0` | `0` = anyone with the link can unpin (like pin); `1` = unpinning requires the admin token. Pinning is always open |
| `IP_SALT` | _(none)_ | Salt for IP hashing (set a random value) |
| `TRUST_PROXY` | `1` | Trust `X-Forwarded-For` / `X-Real-IP` from nginx for the real client IP (rate limit + `ip_hash`). Set `0` only if Node is exposed directly |
| `CORS_ALLOW_ORIGIN` | `*` | Allowed CORS origin (`*` for any) |
| `STATS_TOP_N` | `5` | How many largest logs to list per app on the catalog dashboard |
| `TRIAGE_REQUIRES_ADMIN` | `0` | `0` = setting log status/tags is open by link (like pin); `1` = requires the admin token |
| `TRIAGE_TAG_MAX_LEN` | `32` | Max chars per tag (longer tags are truncated, not rejected) |
| `TRIAGE_TAG_MAX_COUNT` | `20` | Max tags kept per log (extras dropped after dedupe) |
| `CRASH_SIG_TOP_K` | `8` | Top normalized stack frames folded into a crash signature (higher = finer grouping) |
| `CRASH_RECOMPUTE_BATCH` | `200` | Max pre-feature logs the crashes view backfills with a signature per request. `0` disables the lazy backfill |
| `REDMINE_URL` | _(none)_ | Redmine base URL. Empty disables the "create issue from log" feature (button hidden, endpoint 503) |
| `REDMINE_API_KEY` | _(none)_ | Redmine REST API key (`X-Redmine-API-Key`). Server-side only. Empty also disables the feature |
| `REDMINE_PROJECT_ID` | _(none)_ | Redmine project id/identifier. REQUIRED for issue creation (with URL+key set but this empty, the endpoint returns 502) |
| `REDMINE_TRACKER_ID` | _(none)_ | Optional numeric tracker id; empty uses the project default |
| `REDMINE_TIMEOUT_MS` | `10000` | Per-request timeout (ms) for the outbound Redmine call |

## Adding an app

```bash
# No token (open ingest):
npm run add-app -- mygame "My Game Title"

# With token (token printed once on stdout):
npm run add-app -- mygame "My Game Title" 14

# Custom max retention and token:
npm run add-app -- mygame "My Game Title" 14 --max-retention 90
```

The ingest token is shown **once** and never stored in plaintext. Distribute it to the game client via a secure channel (CI secret / 1Password).

## Sinks (forwarding)

On each successful ingest the server optionally forwards a payload (see CONTRACT.md section 5) to configured sinks. Copy `config/sinks.example.json` to `config/sinks.json` and fill in real webhook URLs.

Supported sink types: `slack`, `discord`, `webhook` (generic), `googlesheet`, `confluence`.

## Catalog features

The catalog (`/browse`, viewer-token gated) groups and triages logs:

- **Crashes** (`/browse/:appId/crashes`): logs are grouped by a normalized stack signature (computed at ingest from the error/exception line plus the top stack frames). Each group shows the count, distinct testers, versions, and a "NEW in `<version>`" / "REGRESSION in `<version>`" badge when a crash first appears in - or returns to - the latest version.
- **Size dashboard**: per-project and per-version storage totals, pinned counts, and the largest logs.
- **Status + tags**: each log has a triage status (new / triaged / in_progress / fixed / wontfix) and free-form tags, set from the viewer page and filtered in the catalog. Open by link by default (set `TRIAGE_REQUIRES_ADMIN=1` to restrict). Triage does not affect retention.
- **Engine**: the catalog shows each project's engine (Unity / GameMaker), detected from the log device info.

## Redmine (create issue from log)

Set `REDMINE_URL`, `REDMINE_API_KEY`, and `REDMINE_PROJECT_ID` to enable a "+ Redmine issue" button on the log viewer. It creates a Redmine issue (POST `/issues.json` with `X-Redmine-API-Key`) that links back to the log, and stores the issue id/url so a second click returns the existing issue (idempotent). The endpoint is viewer-token gated. Leaving `REDMINE_URL` or `REDMINE_API_KEY` empty disables the feature (the button is hidden).

## Deploying

### Docker (fastest)

```bash
cd server
cp .env.example .env        # set BASE_URL, tokens, IP_SALT, etc.
docker compose up -d        # builds the image, mounts ./data and ./blobs
# Register an app inside the container:
docker compose exec fastlogs node scripts/add-app.js mygame "My Game" 30
```

See `Dockerfile` and `docker-compose.yml`. The image runs `src/server.js` and
exposes port 8787.

### systemd / VPS

See `deploy/INSTALL.md` for a generic one-time setup (any VPS: systemd units,
`/var/lib/fastlogs`, nginx reverse proxy, certbot).

For subsequent deploys:
```bash
./deploy/deploy.sh user@host
```

The deploy script rsyncs source files, runs `npm ci --omit=dev` on the server, applies migrations, and restarts `fastlogsd.service`.

## Tests

The canonical command is:

```bash
npm test
```

It runs `test/run.js`, which discovers every `*.test.js` file and hands the
explicit list to the built-in `node:test` runner. Do **not** run
`node --test test/`: passing the bare `test/` directory makes Node treat it as
a single module path and fails with `MODULE_NOT_FOUND`. If you must call the
runner directly, pass a glob instead (`node --test "test/*.test.js"`).

Tests use `node:test` (built-in, no extra deps) and spin up a real server on a random port with an isolated SQLite DB in `os.tmpdir()`. No network calls to external services.
