'use strict';

// Centralised configuration loader.
//
// Reads environment variables (optionally seeded from a .env file) and exposes
// a single frozen config object with sane defaults. There is no external
// dotenv dependency: we parse a .env file ourselves to keep dependencies minimal.

const fs = require('node:fs');
const path = require('node:path');

// Project root is the server/ directory (one level above src/).
const SERVER_ROOT = path.resolve(__dirname, '..');

// Minimal .env parser: KEY=VALUE per line, ignores blanks and #-comments.
// Existing process.env values win, so real environment overrides the file.
function loadDotEnv(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return; // No .env file is fine; rely on process.env and defaults.
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Strip a single layer of surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(SERVER_ROOT, '.env'));

// Helpers to coerce env values with defaults.
function envStr(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function envInt(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function envBool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

// Resolve a path that may be relative to the server root.
function resolveDir(p) {
  return path.isAbsolute(p) ? p : path.resolve(SERVER_ROOT, p);
}

const config = Object.freeze({
  // Server.
  port: envInt('PORT', 8787),

  // Bind address. Default 127.0.0.1 (private, behind nginx on bare metal).
  // In Docker set HOST=0.0.0.0 (the published port is mapped only to the
  // host loopback, so it stays private).
  host: envStr('HOST', '127.0.0.1'),

  // Storage locations (absolute).
  serverRoot: SERVER_ROOT,
  dataDir: resolveDir(envStr('DATA_DIR', './data')),
  blobDir: resolveDir(envStr('BLOB_DIR', './blobs')),
  dbPath: path.join(resolveDir(envStr('DATA_DIR', './data')), 'fastlogs.db'),

  // Public URL used to build short links. Neutral localhost default so the
  // server is reusable out of the box; set BASE_URL to your real public URL.
  baseUrl: envStr('BASE_URL', 'http://localhost:8787').replace(/\/+$/, ''),

  // Retention policy (days).
  defaultRetentionDays: envInt('DEFAULT_RETENTION_DAYS', 30),
  maxRetentionDays: envInt('MAX_RETENTION_DAYS', 365),

  // Size limits (bytes).
  maxPayloadBytes: envInt('MAX_PAYLOAD_BYTES', 8 * 1024 * 1024),
  maxScreenshotBytes: envInt('MAX_SCREENSHOT_BYTES', 2 * 1024 * 1024),
  maxLogBytes: envInt('MAX_LOG_BYTES', 20 * 1024 * 1024),

  // Auth tokens (empty string means the corresponding auth tier is disabled).
  adminToken: envStr('ADMIN_TOKEN', ''),
  viewerToken: envStr('VIEWER_TOKEN', ''),

  // Shared "team" ingest token: a single master token valid for ANY app, so all
  // games can share one secret (e.g. from 1Password) instead of per-app tokens.
  // Empty disables it.
  teamToken: envStr('TEAM_INGEST_TOKEN', ''),

  // When true, an unknown appId presented WITH a valid team token is auto-created
  // (tokenless) on first ingest, so new games self-onboard without an admin
  // running add-app.js. Requires TEAM_INGEST_TOKEN to be set.
  allowAutoRegister: envBool('ALLOW_AUTO_REGISTER', false),

  // Unpinning policy. When false (default) unpin is OPEN: anyone with the log
  // link may unpin, mirroring pin (which is always open). When true, unpinning
  // requires the admin token, so only some people (admin-token holders) can unpin.
  unpinRequiresAdmin: envBool('UNPIN_REQUIRES_ADMIN', false),

  // Triage (status/tags) policy. When false (default) triage is OPEN by link:
  // anyone with the log link may set status/tags, mirroring pin. When true, it
  // requires the admin token. triageTagMaxLen/Count bound tag input (longer
  // tags are truncated, extra tags dropped - never rejected).
  triageRequiresAdmin: envBool('TRIAGE_REQUIRES_ADMIN', false),
  triageTagMaxLen: envInt('TRIAGE_TAG_MAX_LEN', 32),
  triageTagMaxCount: envInt('TRIAGE_TAG_MAX_COUNT', 20),

  // Storage dashboard: how many of the largest logs to list per app.
  statsTopN: envInt('STATS_TOP_N', 5),

  // Crash grouping. crashSigTopK = how many top normalized stack frames are
  // folded into a crash signature (higher = finer grouping). crashRecomputeBatch
  // = max crash_sig-NULL logs the /browse/:appId/crashes route lazily backfills
  // per request (bounds first-access latency on a DB of pre-feature logs; 0
  // disables the lazy backfill and relies on the backfill script instead).
  crashSigTopK: envInt('CRASH_SIG_TOP_K', 8),
  crashRecomputeBatch: envInt('CRASH_RECOMPUTE_BATCH', 200),

  // Salt for hashing client IPs before storage.
  ipSalt: envStr('IP_SALT', ''),

  // Trust the X-Forwarded-For / X-Real-IP headers set by the front proxy.
  // Defaults to true because the documented deploy runs Node bound to
  // 127.0.0.1 behind nginx (deploy/nginx-fastlogs.conf), so these headers can
  // only come from the trusted proxy. Set TRUST_PROXY=0 if Node is exposed
  // directly to clients (the headers would then be client-spoofable).
  trustProxy: envBool('TRUST_PROXY', true),

  // CORS allowed origin ("*" for any).
  corsAllowOrigin: envStr('CORS_ALLOW_ORIGIN', '*'),

  // In-process retention sweep cadence (seconds) and per-pass batch size. The
  // server deletes expired, non-pinned logs every interval so the disk stays
  // bounded. 0 disables it (use an external cron / systemd timer instead).
  sweepIntervalSec: envInt('SWEEP_INTERVAL_SEC', 3600),
  sweepBatch: envInt('SWEEP_BATCH', 500),
});

module.exports = config;
