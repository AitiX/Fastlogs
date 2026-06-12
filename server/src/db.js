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
  `);
}

migrate();

// ---------------------------------------------------------------------------
// Prepared statements.
// ---------------------------------------------------------------------------

const stmts = {
  insertLog: db.prepare(`
    INSERT INTO logs (
      id, app_id, platform, app_version, device_json, title, ts_utc,
      cnt_error, cnt_warn, cnt_log, log_bytes, has_shot, created_at,
      expires_at, pinned, ip_hash
    ) VALUES (
      @id, @app_id, @platform, @app_version, @device_json, @title, @ts_utc,
      @cnt_error, @cnt_warn, @cnt_log, @log_bytes, @has_shot, @created_at,
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
    SELECT app_version AS version, COUNT(*) AS count, MAX(created_at) AS last_at
    FROM logs
    WHERE app_id = ?
    GROUP BY app_version
    ORDER BY last_at DESC
  `),

  listLogs: db.prepare(`
    SELECT id, title, ts_utc, platform, cnt_error, cnt_warn, cnt_log,
           has_shot, pinned, created_at, expires_at
    FROM logs
    WHERE app_id = @app_id AND app_version = @version
    ORDER BY created_at DESC
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

// List distinct app_version values for an app with per-version counts.
function listVersions(appId) {
  return stmts.listVersions.all(appId);
}

// List logs of a given app and version, newest first.
function listLogs(appId, version) {
  return stmts.listLogs.all({ app_id: appId, version });
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
  listApps,
  getApp,
  upsertApp,
  listVersions,
  listLogs,
  bumpRate,
};
