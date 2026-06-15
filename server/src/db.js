'use strict';

// SQLite access layer for FastLogs.
//
// Uses better-sqlite3 (synchronous API). The database stores metadata, the
// catalog index, registered apps and rate-limit counters. Log bodies (gzip)
// and screenshots (png) live on disk as blobs, not in the database.
//
// Migrations are idempotent: every CREATE uses IF NOT EXISTS, so importing this
// module is safe to run repeatedly. All public functions are thin wrappers over
// prepared statements built once at module load.

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');

// Ensure the data directory exists before opening the database file.
fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(config.dbPath);

// Pragmas: WAL for better read/write concurrency, NORMAL sync for throughput,
// and foreign keys on for referential integrity.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema (idempotent migrations).
// ---------------------------------------------------------------------------

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS apps (
      app_id             TEXT PRIMARY KEY,
      name               TEXT NOT NULL,
      token_hash         TEXT,
      retention_days     INTEGER NOT NULL DEFAULT 30,
      max_retention_days INTEGER NOT NULL DEFAULT 365,
      sinks_json         TEXT,
      enabled            INTEGER NOT NULL DEFAULT 1,
      created_at         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS logs (
      id          TEXT PRIMARY KEY,
      app_id      TEXT NOT NULL,
      platform    TEXT NOT NULL,
      app_version TEXT NOT NULL,
      device_json TEXT,
      title       TEXT,
      ts_utc      TEXT NOT NULL,
      cnt_error   INTEGER NOT NULL DEFAULT 0,
      cnt_warn    INTEGER NOT NULL DEFAULT 0,
      cnt_log     INTEGER NOT NULL DEFAULT 0,
      log_bytes   INTEGER NOT NULL DEFAULT 0,
      has_shot    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      expires_at  TEXT,
      pinned      INTEGER NOT NULL DEFAULT 0,
      ip_hash     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_logs_expires
      ON logs (expires_at) WHERE pinned = 0;

    CREATE INDEX IF NOT EXISTS idx_logs_app
      ON logs (app_id, created_at);

    CREATE TABLE IF NOT EXISTS rate_counters (
      key          TEXT PRIMARY KEY,
      window_start INTEGER NOT NULL,
      count        INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS files (
      id          TEXT PRIMARY KEY,
      app_id      TEXT NOT NULL,
      app_version TEXT,
      platform    TEXT,
      log_id      TEXT,
      group_id    TEXT,
      name        TEXT NOT NULL,
      mime        TEXT,
      kind        TEXT,
      size_bytes  INTEGER NOT NULL DEFAULT 0,
      sha256      TEXT,
      title       TEXT,
      tester      TEXT,
      created_at  TEXT NOT NULL,
      expires_at  TEXT,
      pinned      INTEGER NOT NULL DEFAULT 0,
      ip_hash     TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_files_expires
      ON files (expires_at) WHERE pinned = 0;

    CREATE INDEX IF NOT EXISTS idx_files_log
      ON files (log_id) WHERE log_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_files_app
      ON files (app_id, created_at);
  `);

  // Additive column migrations for databases created by an earlier version.
  // ADD COLUMN is the safe, idempotent way to evolve the schema; guarding with
  // table_info keeps a re-run a no-op.
  const logCols = db.prepare('PRAGMA table_info(logs)').all();
  for (const col of ['comment', 'tester', 'context_json', 'breadcrumbs_json', 'crash_sig', 'tags', 'redmine_issue_id', 'redmine_issue_url', 'engine', 'scene_context', 'correlation_code']) {
    if (!logCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE logs ADD COLUMN ${col} TEXT`);
    }
  }

  // Triage status. Kept OUT of the bare-TEXT loop because it is NOT NULL with a
  // DEFAULT: SQLite requires a constant DEFAULT to ADD a NOT NULL column to a
  // non-empty table, and 'new' backfills every existing row. logCols snapshot
  // is still valid (the loop above does not touch status).
  if (!logCols.some((c) => c.name === 'status')) {
    db.exec(`ALTER TABLE logs ADD COLUMN status TEXT NOT NULL DEFAULT 'new'`);
  }

  // Number of screenshots stored for a log (0..MAX_SCREENSHOTS). NOT NULL with a
  // constant DEFAULT so existing rows backfill to 0. has_shot stays in sync
  // (has_shot = shot_count > 0) for the back-compat single-screenshot path.
  if (!logCols.some((c) => c.name === 'shot_count')) {
    db.exec(`ALTER TABLE logs ADD COLUMN shot_count INTEGER NOT NULL DEFAULT 0`);
  }

  // Partial index backing the per-app crash grouping scan. Created AFTER the
  // loop above, since crash_sig only exists once that ALTER has run (it is not
  // part of the inline CREATE TABLE). Idempotent via IF NOT EXISTS.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_crash ON logs (app_id, crash_sig) WHERE crash_sig IS NOT NULL`);

  // Index backing the /api/await lookup (most recent log of an app by debug
  // code). Created AFTER the loop, since correlation_code only exists once that
  // ALTER has run. Idempotent via IF NOT EXISTS.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_code ON logs (app_id, correlation_code) WHERE correlation_code IS NOT NULL`);
}

migrate();

// ---------------------------------------------------------------------------
// Prepared statements.
// ---------------------------------------------------------------------------

const stmts = {
  insertLog: db.prepare(`
    INSERT INTO logs (
      id, app_id, platform, app_version, device_json, title, comment, tester,
      context_json, breadcrumbs_json, scene_context, correlation_code,
      crash_sig, engine, ts_utc,
      cnt_error, cnt_warn, cnt_log, log_bytes, has_shot, shot_count, created_at,
      expires_at, pinned, ip_hash
    ) VALUES (
      @id, @app_id, @platform, @app_version, @device_json, @title, @comment, @tester,
      @context_json, @breadcrumbs_json, @scene_context, @correlation_code,
      @crash_sig, @engine, @ts_utc,
      @cnt_error, @cnt_warn, @cnt_log, @log_bytes, @has_shot, @shot_count, @created_at,
      @expires_at, @pinned, @ip_hash
    )
  `),

  getLog: db.prepare(`SELECT * FROM logs WHERE id = ?`),

  deleteLog: db.prepare(`DELETE FROM logs WHERE id = ?`),

  listExpired: db.prepare(`
    SELECT * FROM logs
    WHERE pinned = 0 AND expires_at IS NOT NULL AND expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT ?
  `),

  setPin: db.prepare(`
    UPDATE logs SET pinned = @pinned, expires_at = @expires_at WHERE id = @id
  `),

  listApps: db.prepare(`SELECT * FROM apps ORDER BY app_id ASC`),

  getApp: db.prepare(`SELECT * FROM apps WHERE app_id = ?`),

  upsertApp: db.prepare(`
    INSERT INTO apps (
      app_id, name, token_hash, retention_days, max_retention_days,
      sinks_json, enabled, created_at
    ) VALUES (
      @app_id, @name, @token_hash, @retention_days, @max_retention_days,
      @sinks_json, @enabled, @created_at
    )
    ON CONFLICT(app_id) DO UPDATE SET
      name               = excluded.name,
      token_hash         = excluded.token_hash,
      retention_days     = excluded.retention_days,
      max_retention_days = excluded.max_retention_days,
      sinks_json         = excluded.sinks_json,
      enabled            = excluded.enabled
  `),

  listVersions: db.prepare(`
    SELECT app_version AS version, COUNT(*) AS count, MAX(created_at) AS last_at,
           COALESCE(SUM(log_bytes), 0) AS totalBytes,
           COALESCE(SUM(pinned), 0) AS pinnedCount
    FROM logs
    WHERE app_id = ?
    GROUP BY app_version
    ORDER BY last_at DESC
  `),

  // Storage rollup per app (all rows present, incl. expired-not-yet-swept, so
  // it reflects true on-disk usage). Used by the catalog projects list.
  statsByApp: db.prepare(`
    SELECT app_id,
           COUNT(*) AS logCount,
           COALESCE(SUM(log_bytes), 0) AS totalBytes,
           COALESCE(SUM(pinned), 0) AS pinnedCount
    FROM logs
    GROUP BY app_id
  `),

  // Single-row storage rollup for one app.
  statsForApp: db.prepare(`
    SELECT COUNT(*) AS logCount,
           COALESCE(SUM(log_bytes), 0) AS totalBytes,
           COALESCE(SUM(pinned), 0) AS pinnedCount
    FROM logs
    WHERE app_id = @app_id
  `),

  // The largest logs of an app (for the storage dashboard panel).
  largestLogs: db.prepare(`
    SELECT id, title, app_version, platform, log_bytes, created_at
    FROM logs
    WHERE app_id = @app_id
    ORDER BY log_bytes DESC
    LIMIT @limit
  `),

  listLogs: db.prepare(`
    SELECT id, title, ts_utc, platform, cnt_error, cnt_warn, cnt_log,
           log_bytes, has_shot, pinned, status, tags, crash_sig, engine,
           created_at, expires_at
    FROM logs
    WHERE app_id = @app_id AND app_version = @version
    ORDER BY created_at DESC
  `),

  // Engine (Unity / GameMaker / ...) of the MOST RECENT log per app. SQLite
  // takes the bare `engine` from the row holding MAX(created_at).
  enginesByApp: db.prepare(`
    SELECT app_id, engine, MAX(created_at) AS last_at
    FROM logs
    WHERE engine IS NOT NULL AND engine != ''
    GROUP BY app_id
  `),

  setStatus: db.prepare(`UPDATE logs SET status = @status WHERE id = @id`),

  setTags: db.prepare(`UPDATE logs SET tags = @tags WHERE id = @id`),

  setRedmine: db.prepare(`
    UPDATE logs SET redmine_issue_id = @redmine_issue_id, redmine_issue_url = @redmine_issue_url
    WHERE id = @id
  `),

  // Raw crash rows for one app (grouping + first/last-seen done in JS so the
  // version compare is authoritative). Liveness mirrors getLiveLog (pinned OR
  // not-yet-expired) so the crashes view never counts logs the sweeper drops.
  // crash_sig '' is the "computed, not a crash" sentinel and is excluded.
  listCrashRows: db.prepare(`
    SELECT id, crash_sig, app_version, title, platform, tester, created_at, cnt_error
    FROM logs
    WHERE app_id = @app_id AND crash_sig IS NOT NULL AND crash_sig != ''
          AND (pinned = 1 OR expires_at IS NULL OR expires_at > @now)
  `),

  // Ids of this app's logs whose crash_sig was never computed (pre-feature
  // logs), for the lazy backfill in the crashes route.
  listLogsMissingSig: db.prepare(`
    SELECT id FROM logs WHERE app_id = @app_id AND crash_sig IS NULL LIMIT @limit
  `),

  updateCrashSig: db.prepare(`UPDATE logs SET crash_sig = @crash_sig WHERE id = @id`),

  // Most recent LIVE log of an app matching a debug/await code. Liveness mirrors
  // getLiveLog / listCrashRows (pinned OR not-yet-expired). A direct
  // correlation_code match is preferred; failing that, a code embedded in the
  // free-text comment (LIKE %code%) is the fallback. Newest by created_at.
  // @codeLike is the caller-escaped "%<code>%" pattern with @esc as the ESCAPE
  // char so a code containing % or _ cannot widen the match.
  getLatestByCode: db.prepare(`
    SELECT id, created_at FROM logs
    WHERE app_id = @app_id
          AND (pinned = 1 OR expires_at IS NULL OR expires_at > @now)
          AND (correlation_code = @code
               OR (comment IS NOT NULL AND comment LIKE @codeLike ESCAPE @esc))
    ORDER BY created_at DESC
    LIMIT 1
  `),

  rateGet: db.prepare(`SELECT window_start, count FROM rate_counters WHERE key = ?`),

  rateUpsert: db.prepare(`
    INSERT INTO rate_counters (key, window_start, count)
    VALUES (@key, @window_start, 1)
    ON CONFLICT(key) DO UPDATE SET
      window_start = CASE
        WHEN excluded.window_start > rate_counters.window_start
          THEN excluded.window_start ELSE rate_counters.window_start END,
      count = CASE
        WHEN excluded.window_start > rate_counters.window_start
          THEN 1 ELSE rate_counters.count + 1 END
  `),

  // --- Standalone file uploads (POST /api/files) ---------------------------

  insertFile: db.prepare(`
    INSERT INTO files (
      id, app_id, app_version, platform, log_id, group_id, name, mime, kind,
      size_bytes, sha256, title, tester, created_at, expires_at, pinned, ip_hash
    ) VALUES (
      @id, @app_id, @app_version, @platform, @log_id, @group_id, @name, @mime, @kind,
      @size_bytes, @sha256, @title, @tester, @created_at, @expires_at, @pinned, @ip_hash
    )
  `),

  getFile: db.prepare(`SELECT * FROM files WHERE id = ?`),

  deleteFile: db.prepare(`DELETE FROM files WHERE id = ?`),

  listExpiredFiles: db.prepare(`
    SELECT * FROM files
    WHERE pinned = 0 AND expires_at IS NOT NULL AND expires_at <= ?
    ORDER BY expires_at ASC
    LIMIT ?
  `),

  // Files attached to a log, oldest first (the order they were uploaded). The
  // liveness filter mirrors getLiveFile (pinned OR not-yet-expired) so the
  // attachments list never surfaces files the sweeper is about to drop.
  listFilesByLog: db.prepare(`
    SELECT * FROM files
    WHERE log_id = @log_id
          AND (pinned = 1 OR expires_at IS NULL OR expires_at > @now)
    ORDER BY created_at ASC
  `),

  setFilePin: db.prepare(`
    UPDATE files SET pinned = @pinned, expires_at = @expires_at WHERE id = @id
  `),
};

// ---------------------------------------------------------------------------
// Public API. Each function maps directly onto a prepared statement.
// ---------------------------------------------------------------------------

// Insert a new log row. `row` must contain all named columns (see insertLog).
function insertLog(row) {
  return stmts.insertLog.run(row);
}

// Fetch a single log row by id, or undefined if absent.
function getLog(id) {
  return stmts.getLog.get(id);
}

// Delete a log row by id. Returns the run info (changes count).
function deleteLog(id) {
  return stmts.deleteLog.run(id);
}

// List up to `limit` non-pinned logs whose expires_at is at or before `now`
// (an ISO-8601 UTC string). Used by the retention sweeper.
function listExpired(now, limit) {
  return stmts.listExpired.all(now, limit);
}

// Set the pinned flag and expires_at for a log.
// `pinned` is 0|1, `expiresAt` is an ISO string or null (null => never expires).
function setPin(id, pinned, expiresAt) {
  return stmts.setPin.run({ id, pinned: pinned ? 1 : 0, expires_at: expiresAt });
}

// Set a log's triage status (one of the allowed enum values, validated by the
// route).
function setStatus(id, status) {
  return stmts.setStatus.run({ id, status });
}

// Set a log's tags. `tagsJson` is a JSON-array string, or null for "no tags".
function setTags(id, tagsJson) {
  return stmts.setTags.run({ id, tags: tagsJson });
}

// Link a log to a created Redmine issue. issueId is coerced to a string (the
// column is TEXT); issueUrl is the browser-facing issue URL.
function setRedmine(id, issueId, issueUrl) {
  return stmts.setRedmine.run({
    id,
    redmine_issue_id: issueId == null ? null : String(issueId),
    redmine_issue_url: issueUrl || null,
  });
}

// List all registered apps.
function listApps() {
  return stmts.listApps.all();
}

// Fetch a single app by app_id, or undefined if absent.
function getApp(appId) {
  return stmts.getApp.get(appId);
}

// Insert or update an app. `row` must contain all named columns (see upsertApp).
function upsertApp(row) {
  return stmts.upsertApp.run(row);
}

// List distinct app_version values for an app with per-version counts + sizes.
function listVersions(appId) {
  return stmts.listVersions.all(appId);
}

// Storage rollup for all apps (array of { app_id, logCount, totalBytes, pinnedCount }).
function statsByApp() {
  return stmts.statsByApp.all();
}

// Engine name of the latest log per app (array of { app_id, engine, last_at }).
function enginesByApp() {
  return stmts.enginesByApp.all();
}

// Storage rollup for one app ({ logCount, totalBytes, pinnedCount }).
function statsForApp(appId) {
  return stmts.statsForApp.get({ app_id: appId });
}

// The `limit` largest logs of an app, largest first.
function largestLogs(appId, limit) {
  return stmts.largestLogs.all({ app_id: appId, limit });
}

// List logs of a given app and version, newest first.
function listLogs(appId, version) {
  return stmts.listLogs.all({ app_id: appId, version });
}

// Live crash rows for an app (`now` is an ISO-8601 UTC string for the liveness
// filter). Returns raw rows; the route groups them by crash_sig.
function listCrashRows(appId, now) {
  return stmts.listCrashRows.all({ app_id: appId, now });
}

// Ids of up to `limit` logs of an app whose crash_sig is NULL (never computed).
function listLogsMissingSig(appId, limit) {
  return stmts.listLogsMissingSig.all({ app_id: appId, limit });
}

// Most recent LIVE log of `appId` whose correlation_code equals `code`, or
// (fallback) whose comment contains `code`. `now` is an ISO-8601 UTC string for
// the liveness filter. Returns { id, created_at } or null when nothing matches.
function getLatestByCode(appId, code, now) {
  // Escape SQL LIKE wildcards so a literal % or _ in the code is matched as-is.
  const escaped = String(code).replace(/[\\%_]/g, (ch) => '\\' + ch);
  const row = stmts.getLatestByCode.get({
    app_id: appId,
    code,
    codeLike: `%${escaped}%`,
    esc: '\\',
    now,
  });
  return row || null;
}

// Set a log's crash_sig. `sig` is the signature, or '' for "not a crash".
function updateCrashSig(id, sig) {
  return stmts.updateCrashSig.run({ id, crash_sig: sig });
}

// --- Standalone file uploads -----------------------------------------------

// Insert a new file row. `row` must contain all named columns (see insertFile).
function insertFile(row) {
  return stmts.insertFile.run(row);
}

// Fetch a single file row by id, or undefined if absent.
function getFile(id) {
  return stmts.getFile.get(id);
}

// Delete a file row by id. Returns the run info (changes count).
function deleteFile(id) {
  return stmts.deleteFile.run(id);
}

// List up to `limit` non-pinned files whose expires_at is at or before `now`
// (an ISO-8601 UTC string). Used by the retention sweeper.
function listExpiredFiles(now, limit) {
  return stmts.listExpiredFiles.all(now, limit);
}

// Live files attached to a log (`now` is an ISO-8601 UTC string for the liveness
// filter), oldest first. Returns raw rows; the route shapes them.
function listFilesByLog(logId, now) {
  return stmts.listFilesByLog.all({ log_id: logId, now });
}

// Set the pinned flag and expires_at for a file.
// `pinned` is 0|1, `expiresAt` is an ISO string or null (null => never expires).
function setFilePin(id, pinned, expiresAt) {
  return stmts.setFilePin.run({ id, pinned: pinned ? 1 : 0, expires_at: expiresAt });
}

// Increment a rate-limit counter for `key` within the window starting at
// `windowStart` (an integer, e.g. epoch-seconds aligned to the window). If the
// stored window is older it is reset to 1. Returns the current count in-window.
function bumpRate(key, windowStart) {
  const tx = db.transaction(() => {
    stmts.rateUpsert.run({ key, window_start: windowStart });
    const row = stmts.rateGet.get(key);
    return row ? row.count : 1;
  });
  return tx();
}

module.exports = {
  db,
  migrate,
  insertLog,
  getLog,
  deleteLog,
  listExpired,
  setPin,
  setStatus,
  setTags,
  setRedmine,
  listApps,
  getApp,
  upsertApp,
  listVersions,
  statsByApp,
  enginesByApp,
  statsForApp,
  largestLogs,
  listLogs,
  listCrashRows,
  listLogsMissingSig,
  getLatestByCode,
  updateCrashSig,
  insertFile,
  getFile,
  deleteFile,
  listExpiredFiles,
  listFilesByLog,
  setFilePin,
  bumpRate,
};
