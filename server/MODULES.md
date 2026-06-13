# FastLogs server - module contract

Exact export signatures of the core modules under `server/src`. This is the
contract for the remaining builders (routes, sinks, sweeper, viewer). Source of
truth for the API/data shape is `../CONTRACT.md`; this file describes the
internal module API only.

Runtime: Node.js (CommonJS, `require`/`module.exports`), node >= 18. Storage:
SQLite via `better-sqlite3` (synchronous). Async modules (`storage`,
`util/http`) return Promises.

All paths in config are absolute. Time strings are ISO-8601 UTC.

---

## `src/config.js`

Frozen config object (singleton). `require('./config')` returns:

| Field | Type | Meaning |
|-------|------|---------|
| `port` | number | HTTP listen port (default 8787) |
| `serverRoot` | string | Absolute path to `server/` |
| `dataDir` | string | Absolute DB directory |
| `blobDir` | string | Absolute blob directory |
| `dbPath` | string | Absolute path to `fastlogs.db` inside `dataDir` |
| `baseUrl` | string | Public base URL, no trailing slash |
| `defaultRetentionDays` | number | Default retention (30) |
| `maxRetentionDays` | number | Hard retention ceiling (365) |
| `maxPayloadBytes` | number | Whole-body limit (~8 MB) |
| `maxScreenshotBytes` | number | PNG limit (~2 MB) |
| `maxLogBytes` | number | Decompressed log limit (~20 MB) |
| `adminToken` | string | Admin token; `''` => admin tier disabled |
| `viewerToken` | string | Viewer token; `''` => viewer tier disabled |
| `ipSalt` | string | Salt for IP hashing |
| `corsAllowOrigin` | string | Allowed origin, `'*'` for any |
| `unpinRequiresAdmin` | boolean | Unpin requires the admin token when true |
| `triageRequiresAdmin` | boolean | Status/tags require the admin token when true (else open by link) |
| `triageTagMaxLen` / `triageTagMaxCount` | number | Per-tag length cap (32) / tags-per-log cap (20) |
| `statsTopN` | number | Largest-logs count for the dashboard (5) |
| `crashSigTopK` / `crashRecomputeBatch` | number | Crash signature frame count (8) / lazy-backfill batch (200) |
| `redmine` | object | `{ url, apiKey, projectId, trackerId, timeoutMs, enabled }`; `enabled` = url && apiKey |

(Other env-driven fields - `teamToken`, `allowAutoRegister`, `trustProxy`,
`sweepIntervalSec`, `sweepBatch` - exist too; see `.env.example` for the full set.)

Reads a `.env` file from `serverRoot` if present (real env vars win). No
external dotenv dependency.

---

## `src/db.js`

SQLite layer. Opens the DB (WAL, foreign_keys ON), runs idempotent migrations
on load. Exports:

- `db` - the raw `better-sqlite3` Database instance (escape hatch for tx/admin).
- `migrate(): void` - re-run idempotent migrations (also run automatically on import).

- `insertLog(row): RunResult` - insert a log. `row` keys (all required):
  `{ id, app_id, platform, app_version, device_json, title, comment, tester,
     context_json, breadcrumbs_json, crash_sig, engine, ts_utc,
     cnt_error, cnt_warn, cnt_log, log_bytes, has_shot, created_at,
     expires_at, pinned, ip_hash }`.
  `device_json` is a JSON string (or null); `expires_at` is ISO string or null;
  `has_shot`/`pinned` are 0|1.
- `getLog(id): Row | undefined` - full log row by id.
- `deleteLog(id): RunResult` - delete a log row by id (`.changes` = rows deleted).
- `listExpired(now, limit): Row[]` - non-pinned logs with `expires_at <= now`
  (ISO string), oldest first, capped at `limit`. For the sweeper.
- `setPin(id, pinned, expiresAt): RunResult` - set `pinned` (0|1) and
  `expires_at` (ISO string or null). pin=true => pass `(id, 1, null)`.
- `listApps(): Row[]` - all apps, ordered by `app_id`.
- `getApp(appId): Row | undefined` - app row by id.
- `upsertApp(row): RunResult` - insert/update an app. `row` keys (all required):
  `{ app_id, name, token_hash, retention_days, max_retention_days,
     sinks_json, enabled, created_at }`.
  `token_hash` is a sha256 hex string or null; `enabled` is 0|1;
  `sinks_json` is a JSON string or null.
- `listVersions(appId): Array<{ version, count, last_at, totalBytes, pinnedCount }>` -
  distinct `app_version` values with per-version counts, latest `created_at`,
  total bytes and pinned count.
- `listLogs(appId, version): Row[]` - logs of one app+version, newest first.
  Columns: `id, title, ts_utc, platform, cnt_error, cnt_warn, cnt_log,
  log_bytes, has_shot, pinned, status, tags, crash_sig, engine, created_at, expires_at`.
- `statsByApp(): Array<{ app_id, logCount, totalBytes, pinnedCount }>` - storage rollup per app (all rows present).
- `statsForApp(appId): { logCount, totalBytes, pinnedCount }` - storage rollup for one app.
- `enginesByApp(): Array<{ app_id, engine, last_at }>` - engine of the latest log per app.
- `largestLogs(appId, limit): Row[]` - the `limit` largest logs of an app by `log_bytes`, largest first.
- `listCrashRows(appId, now): Row[]` - live crash rows (crash_sig set, not `''`) for grouping.
  Columns: `id, crash_sig, app_version, title, platform, tester, created_at, cnt_error`.
- `listLogsMissingSig(appId, limit): Array<{ id }>` - up to `limit` logs of an app with `crash_sig` NULL (lazy backfill).
- `updateCrashSig(id, sig): RunResult` - set `crash_sig` (`''` = computed, not a crash).
- `setStatus(id, status): RunResult` - set the triage status enum.
- `setTags(id, tagsJson): RunResult` - set tags (JSON-array string, or null for none).
- `setRedmine(id, issueId, issueUrl): RunResult` - link a created Redmine issue (issueId coerced to string).
- `bumpRate(key, windowStart): number` - atomically increment the rate counter
  for `key` in window `windowStart` (integer window index); resets on window
  rollover. Returns the post-increment count in-window.

### Schema
- `apps(app_id PK, name, token_hash, retention_days DEFAULT 30,
   max_retention_days DEFAULT 365, sinks_json, enabled DEFAULT 1, created_at)`.
- `logs(id PK, app_id, platform, app_version, device_json, title, ts_utc,
   cnt_error, cnt_warn, cnt_log, log_bytes, has_shot DEFAULT 0, created_at,
   expires_at NULL, pinned DEFAULT 0, ip_hash)` plus additive columns
   `comment, tester, context_json, breadcrumbs_json, crash_sig, tags,
   redmine_issue_id, redmine_issue_url, engine` (all nullable TEXT) and
   `status TEXT NOT NULL DEFAULT 'new'`.
- Indexes: `idx_logs_expires(expires_at) WHERE pinned=0`,
   `idx_logs_app(app_id, created_at)`,
   `idx_logs_crash(app_id, crash_sig) WHERE crash_sig IS NOT NULL`.
- `rate_counters(key PK, window_start, count)`.

---

## `src/id.js`

Short base62 ids.

- `newId(existsFn, startLength = 6): string` - unique id; `existsFn(id)` returns
  truthy if id taken. Grows length on repeated collisions. Default length 6.
- `randomBase62(length): string` - uniform random base62 string (rejection
  sampling, no modulo bias).
- `ALPHABET: string` - the 62-char alphabet (`0-9A-Za-z`).
- `DEFAULT_LENGTH: number` - 6.

---

## `src/storage.js`

Blob storage on disk, sharded by the first two chars of the id. Layout:
`<blobDir>/<shard>/<id>.log.gz` and `<id>.png`. All async functions return Promises.

- `saveLogGz(id, data, alreadyGzipped = false): Promise<number>` - store a log
  body; gzips `data` (string/Buffer) unless `alreadyGzipped`. Returns bytes
  written (gzipped size).
- `readLogGz(id, opts?): Promise<string | Buffer | null>` - decompressed text by
  default; `{ raw: true }` returns the raw gzip Buffer (for serving `.log.gz`
  directly). `null` if missing.
- `saveShot(id, data): Promise<number>` - store PNG (`data` is Buffer or base64
  string). Returns bytes written.
- `readShot(id): Promise<Buffer | null>` - PNG bytes, or null if missing.
- `removeBlobs(id): Promise<number>` - delete log + screenshot blobs; returns
  count removed (0-2). Missing files ignored.
- `logPath(id): string` / `shotPath(id): string` - absolute blob paths.
- `shardDir(id): string` / `shardOf(id): string` - shard directory / shard key.
- `logExistsSync(id): boolean` - synchronous existence check for the log blob.

---

## `src/auth.js`

- `sha256(value): string` - lowercase hex sha256 of a string.
- `safeEqual(a, b): boolean` - constant-time string comparison.
- `parseBearer(headerValue): string | null` - extract token from an
  `Authorization: Bearer <token>` header value.
- `validateIngest(appId, bearer): { ok, app, code }` - validate an ingest
  request. `bearer` is the raw Authorization header value. `code` is one of
  `'ok' | 'unauthorized' | 'forbidden'` (maps to HTTP 200/401/403). `app` is the
  app row (may be null on failure). Rules: unknown/disabled app => forbidden;
  app needs token but none given => unauthorized; token mismatch => forbidden;
  app without token => ok.
- `isAdmin(token): boolean` - true if raw `token` equals `config.adminToken`
  (false if admin token is empty/disabled).
- `isViewer(token): boolean` - true if raw `token` matches the viewer token;
  the admin token also satisfies viewer access.

---

## `src/cors.js`

- `applyCors(req, res): void` - set CORS headers from `config.corsAllowOrigin`.
  With `'*'` sets `Allow-Origin: *` and never sets `Allow-Credentials`; with a
  concrete origin echoes it and sets `Vary: Origin`. Always sets
  `Allow-Methods: GET, POST, OPTIONS`, `Allow-Headers: Authorization,
  Content-Type`, `Max-Age: 86400`.
- `handlePreflight(req, res): boolean` - if `req.method === 'OPTIONS'`, write
  CORS headers, respond `204`, return `true` (handled). Otherwise return `false`.
- `ALLOW_METHODS`, `ALLOW_HEADERS`, `MAX_AGE_SECONDS` - the header constants.

---

## `src/ratelimit.js`

- `check(key, limit, windowSec): { allowed, retryAfter, count, limit }` -
  fixed-window check that consumes one unit for `key`. `allowed` is false once
  `count > limit`; `retryAfter` is seconds until the next window boundary (0
  when allowed). Suggested keys: `ingest:ip:<ip_hash>`, `ingest:app:<app_id>`.

---

## `src/util/http.js`

- `nowUtcIso(): string` - current time as ISO-8601 UTC.
- `sendJson(res, status, obj, extraHeaders?): void` - JSON response.
- `sendText(res, status, text, extraHeaders?): void` - text/buffer response.
- `sendError(res, status, code, message, extraHeaders?): void` - CONTRACT error
  body `{ error: code, message }`.
- `readBuffer(req, maxBytes): Promise<Buffer>` - read body with byte cap;
  rejects with `err.code === 'PAYLOAD_TOO_LARGE'` on overflow.
- `readJsonBody(req, maxBytes): Promise<object>` - read+parse JSON, honoring
  `Content-Encoding: gzip` (inflates with the same `maxBytes` ceiling). Throws
  errors with `.code`: `'PAYLOAD_TOO_LARGE'` (413), `'BAD_JSON'` (400),
  `'BAD_ENCODING'` (400).

---

## `src/crashsig.js`

Pure crash-signature module (only `node:crypto`).

- `computeSignature(logText, opts?): string | null` - 12-char sha1 of the
  exception type + top K normalized stack frames of the most recent `[E]`
  (error) entry. `null` when the log has no error entry (not a crash).
  `opts.topK` overrides the default frame count.
- `parseEntries`, `pickError`, `exceptionType`, `normalizeMessage`,
  `normalizeFrame`, `isFrameLine` - the building blocks (unit-tested directly).
- `TOP_K` (8), `SIG_LEN` (12) - defaults.

---

## `src/util/version.js`

Total ordering for version strings (no deps, never throws).

- `compareVersions(a, b, createdAtA?, createdAtB?): -1 | 0 | 1` - semver ->
  loose numeric-dotted -> created_at -> lexicographic, with created_at as the
  tiebreaker for equal versions.
- `parseSemver(s): { major, minor, patch, pre } | null`.

---

## `src/redmine.js`

Redmine REST client + content builders (Node global `fetch` + `AbortController`,
no new deps).

- `buildIssueContent(row, publicUrl, overrides?): { subject, description }`.
- `createIssue({ url, apiKey, projectId, trackerId, subject, description, timeoutMs }): Promise<{ ok:true, issueId, raw } | { ok:false, kind, status?, detail }>` -
  never throws; `kind` is `'validation' | 'auth' | 'http' | 'network'`.

---

## Notes for downstream builders

- `package.json` declares scripts `start`/`test`/`sweep`/`add-app`/`migrate`
  pointing at `src/server.js`, `test/run.js`, `scripts/sweep.js`,
  `scripts/add-app.js`, `scripts/migrate.js` - those files are not part of this
  core and are to be created by the route/script builders.
- Error `code` strings in `auth.validateIngest` align with CONTRACT tokens; the
  route layer maps them to HTTP statuses and the `{ error, message }` body.
- Retention: route layer clamps `retentionDays` to `[1, app.max_retention_days]`
  and computes `expires_at = created_at + days` (ISO). Pinned logs use
  `expires_at = null`.
