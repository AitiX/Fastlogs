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

// Whether the SQLite build has FTS5 (set during migrate). When false, the
// search index is absent and the search helpers below are no-ops / empty, so
// the rest of the server keeps working without full-text search.
let ftsAvailable = false;

// Map a base62 log id to a stable positive integer rowid for the FTS table.
// FTS5 indexes by integer rowid; deriving it from the id lets us delete/replace
// an entry by id (the FTS table is contentless, so it cannot be joined back to
// logs.id on its own). FNV-1a over the id bytes, folded into the JS
// safe-integer range (< 2^53) so the value survives a round-trip through
// better-sqlite3 as a plain Number with NO precision loss (a 64-bit rowid would
// be truncated on read, breaking the join). Returns a Number, used both to bind
// inserts and to key the search-result map, so both sides compare identically.
// Collisions are astronomically unlikely for short base62 ids and would only
// cause a stale-search row, never data loss.
function ftsRowId(id) {
  // 64-bit FNV-1a using BigInt, then fold to 52 bits (0 .. 2^52-1) which is
  // inside Number.MAX_SAFE_INTEGER (2^53-1). +1 so the rowid is always >= 1
  // (FTS5/SQLite rowids are nonzero positive integers).
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const s = String(id);
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i) & 0xff);
    h = (h * prime) & mask;
  }
  const folded = h & 0xfffffffffffffn; // low 52 bits
  return Number(folded) + 1;
}

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

    -- App aliases: an OLD appId (slug) that keeps resolving to the canonical
    -- app after a rename. The renamer rewrites apps.app_id + logs.app_id to the
    -- new id and records the old id here, so ingest / browse / search under the
    -- old slug keep working without losing any log. "alias" is the old id (PK,
    -- so an alias maps to exactly one app); "app_id" is the canonical target.
    CREATE TABLE IF NOT EXISTS app_aliases (
      alias  TEXT PRIMARY KEY,
      app_id TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_app_aliases_app
      ON app_aliases (app_id);

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
  for (const col of ['comment', 'tester', 'context_json', 'breadcrumbs_json', 'crash_sig', 'tags', 'redmine_issue_id', 'redmine_issue_url', 'engine', 'scene_context', 'correlation_code', 'session_id', 'folder', 'caller_file']) {
    if (!logCols.some((c) => c.name === col)) {
      db.exec(`ALTER TABLE logs ADD COLUMN ${col} TEXT`);
    }
  }

  // Index backing the per-app folder filter + DISTINCT folder listing. Created
  // AFTER the loop, since `folder` only exists once that ALTER has run. Partial
  // so it stays small (the vast majority of logs live in the root, folder NULL).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_folder ON logs (app_id, folder) WHERE folder IS NOT NULL`);

  // Index backing the "all logs of one session" lookup (per-app, newest-first).
  // Created AFTER the loop, since session_id only exists once that ALTER has
  // run. Partial so it stays small (most pre-feature logs have no session).
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_session ON logs (app_id, session_id, created_at) WHERE session_id IS NOT NULL`);

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

  // "Sent from code" provenance flag. NOT NULL with a constant DEFAULT 0 so
  // existing rows backfill to "overlay send" (sent_via_code = 0); ingest sets 1
  // when the report was fired from game code (FastLogs.Send / SendReport / ...).
  // Kept OUT of the bare-TEXT loop for the same reason as shot_count (NOT NULL +
  // DEFAULT must be a constant to ADD onto a non-empty table).
  if (!logCols.some((c) => c.name === 'sent_via_code')) {
    db.exec(`ALTER TABLE logs ADD COLUMN sent_via_code INTEGER NOT NULL DEFAULT 0`);
  }

  // Code call-site line for a code send (paired with caller_file). Nullable
  // INTEGER (no default): null for overlay sends and pre-feature rows. caller_file
  // is a plain nullable TEXT added in the loop above.
  if (!logCols.some((c) => c.name === 'caller_line')) {
    db.exec(`ALTER TABLE logs ADD COLUMN caller_line INTEGER`);
  }

  // Whether this log's text is in the FTS index. NOT NULL with a constant
  // DEFAULT 0 so pre-FTS rows backfill to "not indexed" and the lazy/scripted
  // backfill (listLogsMissingFts) can find them. Set to 1 once indexed.
  if (!logCols.some((c) => c.name === 'fts_indexed')) {
    db.exec(`ALTER TABLE logs ADD COLUMN fts_indexed INTEGER NOT NULL DEFAULT 0`);
  }

  // Partial index backing the per-app crash grouping scan. Created AFTER the
  // loop above, since crash_sig only exists once that ALTER has run (it is not
  // part of the inline CREATE TABLE). Idempotent via IF NOT EXISTS.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_crash ON logs (app_id, crash_sig) WHERE crash_sig IS NOT NULL`);

  // Index backing the /api/await lookup (most recent log of an app by debug
  // code). Created AFTER the loop, since correlation_code only exists once that
  // ALTER has run. Idempotent via IF NOT EXISTS.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_code ON logs (app_id, correlation_code) WHERE correlation_code IS NOT NULL`);

  // ---------------------------------------------------------------------------
  // Full-text search index (FTS5). Created LAST so every column it references
  // (fts_indexed) already exists from the ALTERs above.
  //
  // A CONTENTLESS FTS5 table (content='') indexed by a log's catalog text:
  // title, tester, the free-text comment, the flattened context values and the
  // scene snapshot, plus the (decompressed) log body. Contentless means FTS5
  // stores only the inverted index, not a copy of the text, so the on-disk cost
  // stays bounded and the log body is never duplicated. contentless_delete=1
  // (SQLite >= 3.43) makes DELETE/replace by rowid work on a contentless table,
  // so the index can follow log deletions (sweeper) and re-indexing without a
  // content table. The rowid is a stable integer derived from the log id
  // (ftsRowId) so a row can be deleted/replaced by id. Tokenizer: unicode61 +
  // remove_diacritics for forgiving matching; '_' kept as a token char so
  // identifiers (e.g. correlation codes) stay searchable as one token.
  //
  // Guarded by a try/catch: if the SQLite build lacks FTS5 (or is too old for
  // contentless_delete) the server still runs (search degrades to disabled)
  // instead of failing to boot.
  ftsAvailable = false;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
        title, tester, comment, context, scene, body,
        content='', contentless_delete=1,
        tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
      );
    `);
    // Partial index backing the backfill scan ("logs not yet in FTS"). Only
    // created when FTS exists, since there is nothing to backfill otherwise.
    db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_unindexed ON logs (app_id) WHERE fts_indexed = 0`);
    ftsAvailable = true;
  } catch (err) {
    console.warn('[db] FTS5 unavailable, full-text search disabled:', (err && err.message) || err);
  }
}

migrate();

// ---------------------------------------------------------------------------
// Prepared statements.
// ---------------------------------------------------------------------------

const stmts = {
  insertLog: db.prepare(`
    INSERT INTO logs (
      id, app_id, platform, app_version, device_json, title, comment, tester,
      context_json, breadcrumbs_json, scene_context, correlation_code, session_id,
      sent_via_code, caller_file, caller_line,
      crash_sig, engine, ts_utc,
      cnt_error, cnt_warn, cnt_log, log_bytes, has_shot, shot_count, created_at,
      expires_at, pinned, ip_hash
    ) VALUES (
      @id, @app_id, @platform, @app_version, @device_json, @title, @comment, @tester,
      @context_json, @breadcrumbs_json, @scene_context, @correlation_code, @session_id,
      @sent_via_code, @caller_file, @caller_line,
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
           session_id, folder, created_at, expires_at
    FROM logs
    WHERE app_id = @app_id AND app_version = @version
    ORDER BY created_at DESC
  `),

  // Same as listLogs, but restricted to one exact folder value. A NULL @folder
  // (bound as null) selects the ROOT (folder IS NULL); a non-null value selects
  // that exact folder path. Used by the catalog version view's ?folder= filter.
  listLogsByFolder: db.prepare(`
    SELECT id, title, ts_utc, platform, cnt_error, cnt_warn, cnt_log,
           log_bytes, has_shot, pinned, status, tags, crash_sig, engine,
           session_id, folder, created_at, expires_at
    FROM logs
    WHERE app_id = @app_id AND app_version = @version
          AND folder IS @folder
    ORDER BY created_at DESC
  `),

  // Live logs of one session within an app, newest first. Liveness mirrors
  // getLiveLog (pinned OR not-yet-expired) so the session view never lists logs
  // the sweeper is about to drop. Shaped like listLogs (catalog row columns).
  listLogsBySession: db.prepare(`
    SELECT id, title, ts_utc, platform, cnt_error, cnt_warn, cnt_log,
           log_bytes, has_shot, pinned, status, tags, crash_sig, engine,
           app_version, session_id, folder, created_at, expires_at
    FROM logs
    WHERE app_id = @app_id AND session_id = @session_id
          AND (pinned = 1 OR expires_at IS NULL OR expires_at > @now)
    ORDER BY created_at DESC
  `),

  // Live logs of one app (catalog columns) for the full-text search join. The
  // FTS index is contentless and app-agnostic, so search matches by rowid are
  // intersected with this set in JS (see searchLogs). Liveness mirrors
  // getLiveLog. Newest-first is a stable tiebreak when ranks coincide.
  searchAppRows: db.prepare(`
    SELECT id, title, ts_utc, platform, cnt_error, cnt_warn, cnt_log,
           log_bytes, has_shot, pinned, status, tags, crash_sig, engine,
           app_version, session_id, folder, created_at, expires_at
    FROM logs
    WHERE app_id = @app_id
          AND (pinned = 1 OR expires_at IS NULL OR expires_at > @now)
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

  // --- Full-text search bookkeeping (plain-table statements; always safe) ---

  // Up to `limit` logs of an app whose body is not yet in the FTS index, for the
  // lazy/scripted backfill. Returns the id + the catalog text columns so the
  // caller (which already reads the log body from disk) can build the FTS row.
  listLogsMissingFts: db.prepare(`
    SELECT id, title, tester, comment, context_json, scene_context
    FROM logs
    WHERE app_id = @app_id AND fts_indexed = 0
    LIMIT @limit
  `),

  markFtsIndexed: db.prepare(`UPDATE logs SET fts_indexed = 1 WHERE id = @id`),

  // --- Log folders (manual organisation in the catalog) --------------------

  // Assign (or clear) a single log's folder. @folder is the normalized path
  // string, or null for the root. Scoped by app_id so a move can never reach
  // across projects even if a stale id were passed.
  setLogFolder: db.prepare(`
    UPDATE logs SET folder = @folder WHERE id = @id AND app_id = @app_id
  `),

  // Distinct non-empty folder paths of an app, alphabetically. Backs the folder
  // tree/list in the catalog. The root (folder NULL) is implicit and excluded.
  listFolders: db.prepare(`
    SELECT DISTINCT folder FROM logs
    WHERE app_id = @app_id AND folder IS NOT NULL AND folder != ''
    ORDER BY folder ASC
  `),

  // --- App aliases (rename keeps the old slug working) ---------------------

  // Resolve an alias (old appId) to its canonical app_id, or undefined.
  getAlias: db.prepare(`SELECT app_id FROM app_aliases WHERE alias = ?`),

  // Insert/update an alias -> canonical mapping (idempotent on re-rename).
  upsertAlias: db.prepare(`
    INSERT INTO app_aliases (alias, app_id) VALUES (@alias, @app_id)
    ON CONFLICT(alias) DO UPDATE SET app_id = excluded.app_id
  `),

  // Drop an alias row (used if the canonical id is renamed onto an old alias).
  deleteAlias: db.prepare(`DELETE FROM app_aliases WHERE alias = ?`),

  // Repoint every alias that targeted @old_app_id to @new_app_id (so a chain of
  // renames keeps every historical slug resolving to the latest canonical id).
  repointAliases: db.prepare(`
    UPDATE app_aliases SET app_id = @new_app_id WHERE app_id = @old_app_id
  `),

  // Re-key an app row's primary key (slug). Run inside the rename transaction;
  // logs are re-keyed separately so nothing is lost.
  renameApp: db.prepare(`UPDATE apps SET app_id = @new_app_id WHERE app_id = @old_app_id`),

  // Set an app's display name without touching tokens/retention/etc.
  setAppName: db.prepare(`UPDATE apps SET name = @name WHERE app_id = @app_id`),

  // Move every log of an app from @old_app_id to @new_app_id (the log id itself
  // is unchanged, so per-id links keep working). FTS rows are keyed by log id,
  // so they need no rewrite.
  renameLogsApp: db.prepare(`UPDATE logs SET app_id = @new_app_id WHERE app_id = @old_app_id`),

  // Move every standalone file of an app likewise (kept in lockstep with logs).
  renameFilesApp: db.prepare(`UPDATE files SET app_id = @new_app_id WHERE app_id = @old_app_id`),
};

// ---------------------------------------------------------------------------
// Full-text search statements (FTS5).
//
// Prepared only when the FTS table exists (ftsAvailable). The FTS table is
// contentless, so writes go through dedicated INSERT/delete-by-rowid forms.
// All search reads use a MATCH against a caller-built query string and rank by
// FTS5 bm25 (best matches first). The id list returned by `searchIds` is joined
// back to the logs table by the route to build catalog rows.
// ---------------------------------------------------------------------------

const ftsStmts = ftsAvailable ? {
  // Insert a row into the contentless FTS table at a derived rowid.
  insert: db.prepare(`
    INSERT INTO logs_fts (rowid, title, tester, comment, context, scene, body)
    VALUES (@rowid, @title, @tester, @comment, @context, @scene, @body)
  `),

  // Delete a row by its derived rowid. Works because the table is created with
  // contentless_delete=1, which lets a plain DELETE by rowid drop the
  // inverted-index entries without a content table.
  deleteByRowid: db.prepare(`DELETE FROM logs_fts WHERE rowid = ?`),

  // Search within one app: the rowids matching @match, ranked by relevance.
  // The app scope is applied by the route via the joined logs row (the FTS
  // table holds no app_id); we fetch a bounded number of top matches and let
  // the route filter to the app + liveness. bm25() lower = better.
  search: db.prepare(`
    SELECT rowid, bm25(logs_fts) AS rank
    FROM logs_fts
    WHERE logs_fts MATCH @match
    ORDER BY rank
    LIMIT @limit
  `),
} : null;

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

// Delete a log row by id, and its FTS entry (if any), atomically. Keeping the
// two in one transaction means the search index never points at a deleted log.
// Returns the logs-table run info (changes count) so callers (sweeper) keep
// counting deleted rows as before.
function deleteLog(id) {
  if (!ftsStmts) return stmts.deleteLog.run(id);
  const tx = db.transaction((logId) => {
    ftsStmts.deleteByRowid.run(ftsRowId(logId));
    return stmts.deleteLog.run(logId);
  });
  return tx(id);
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

// Resolve an appId-or-alias to the canonical app_id. A live app row wins (so a
// current id always resolves to itself); failing that an alias (an OLD slug
// recorded by a rename) is followed to its target. Returns the canonical app_id
// string, or null when neither an app nor an alias matches. Used by ingest,
// browse and search so a renamed project's OLD appId keeps working everywhere.
function resolveAppId(idOrAlias) {
  if (!idOrAlias || typeof idOrAlias !== 'string') return null;
  if (stmts.getApp.get(idOrAlias)) return idOrAlias;
  const row = stmts.getAlias.get(idOrAlias);
  return row ? row.app_id : null;
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

// List logs of one app+version restricted to a single folder, newest first.
// `folder` is the exact folder path string, or null for the ROOT (folder NULL).
// Same row shape as listLogs (plus the `folder` column).
function listLogsByFolder(appId, version, folder) {
  return stmts.listLogsByFolder.all({ app_id: appId, version, folder: folder || null });
}

// Assign a log to a folder (or clear it). `folder` is the normalized path, or
// null for the root. Scoped by app_id so the move stays within the project.
// Returns the run info (`.changes` = 1 when the log existed in that app).
function setLogFolder(id, appId, folder) {
  return stmts.setLogFolder.run({ id, app_id: appId, folder: folder || null });
}

// Distinct non-empty folder paths of an app, alphabetically (array of strings).
function listFolders(appId) {
  return stmts.listFolders.all({ app_id: appId }).map((r) => r.folder);
}

// Rename a project: re-key the app row + all its logs/files from `oldAppId` to
// `newAppId`, record the old slug as an alias of the new one, and repoint any
// existing aliases onto the new id. Atomic (single transaction) so a failure
// leaves the project untouched. Nothing is deleted: log ids are unchanged (so
// per-id links keep working) and the blobs on disk are untouched (they are keyed
// by log id, not app_id). `newName` (optional) updates the display name too.
//
// Idempotent: renaming to the SAME id only updates the name. The old slug is
// NOT recorded as an alias of itself; and if `newAppId` happens to be an
// existing alias, that alias row is dropped (it now resolves to itself).
function renameApp(oldAppId, newAppId, newName) {
  const tx = db.transaction(() => {
    if (oldAppId !== newAppId) {
      stmts.renameApp.run({ old_app_id: oldAppId, new_app_id: newAppId });
      stmts.renameLogsApp.run({ old_app_id: oldAppId, new_app_id: newAppId });
      stmts.renameFilesApp.run({ old_app_id: oldAppId, new_app_id: newAppId });
      // Any alias that used to point at the old id now points at the new id, so
      // a chain (a -> b -> c) keeps every historical slug resolving to c.
      stmts.repointAliases.run({ old_app_id: oldAppId, new_app_id: newAppId });
      // The new id must never be its own alias (it resolves via apps directly).
      stmts.deleteAlias.run(newAppId);
      // The old slug becomes an alias of the new canonical id.
      stmts.upsertAlias.run({ alias: oldAppId, app_id: newAppId });
    }
    if (newName != null) {
      stmts.setAppName.run({ app_id: newAppId, name: newName });
    }
  });
  tx();
}

// Live logs of one session within an app, newest first. `now` is an ISO-8601
// UTC string for the liveness filter. Rows are shaped like listLogs (plus
// app_version), so the catalog route can render them with the same mapper.
function listLogsBySession(appId, sessionId, now) {
  return stmts.listLogsBySession.all({ app_id: appId, session_id: sessionId, now });
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

// --- Full-text search ------------------------------------------------------

// True when the SQLite build has FTS5 and the index is live. The search route
// answers 503 when this is false so the feature degrades cleanly.
function searchAvailable() {
  return !!ftsStmts;
}

// Flatten a context map (JSON string) into a single space-joined string of its
// keys and values, so context values are searchable as plain text. Returns ''
// on absence/parse error.
function flattenContextForFts(contextJson) {
  if (!contextJson) return '';
  try {
    const obj = JSON.parse(contextJson);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
    const parts = [];
    for (const k of Object.keys(obj)) {
      parts.push(k);
      const v = obj[k];
      if (v != null) parts.push(String(v));
    }
    return parts.join(' ');
  } catch {
    return '';
  }
}

// Index (or re-index) one log's catalog text + body into the FTS table and mark
// it indexed. `meta` carries the row's text columns (title/tester/comment/
// context_json/scene_context); `body` is the decompressed log text (or ''). A
// no-op when FTS is unavailable. delete-then-insert at the derived rowid makes
// it idempotent (a re-index replaces the prior entry). Wrapped in a transaction
// so the FTS write and the fts_indexed flag flip together.
function indexLog(meta, body) {
  if (!ftsStmts) return;
  const rowid = ftsRowId(meta.id);
  const params = {
    rowid,
    title: meta.title || '',
    tester: meta.tester || '',
    comment: meta.comment || '',
    context: flattenContextForFts(meta.context_json),
    scene: meta.scene_context || '',
    body: body || '',
  };
  const tx = db.transaction(() => {
    ftsStmts.deleteByRowid.run(rowid);
    ftsStmts.insert.run(params);
    stmts.markFtsIndexed.run({ id: meta.id });
  });
  tx();
}

// Up to `limit` logs of an app not yet in the FTS index, with the text columns
// needed to build the FTS row (the caller adds the body it reads from disk).
// Empty array when FTS is unavailable (nothing to backfill).
function listLogsMissingFts(appId, limit) {
  if (!ftsStmts) return [];
  return stmts.listLogsMissingFts.all({ app_id: appId, limit });
}

// Search one app's live logs by full-text query. `match` is the FTS5 MATCH
// string (built + escaped by the route). `now` is the ISO-8601 liveness cutoff.
// `version` (optional) restricts to one exact app_version. Returns up to `limit`
// catalog rows (same shape as listLogs) ranked by FTS5 relevance, restricted to
// this app, the optional version, and live (pinned or not-yet-expired) logs.
// Empty array when FTS is unavailable.
//
// The FTS table is contentless and app-agnostic, so we fetch a generous batch
// of top matches by rowid, then join back to logs by the derived rowid to
// apply the app + version + liveness filter and recover the catalog columns.
// The rowid is reconstructed in JS (ftsRowId) per candidate log, since SQLite
// cannot invert the hash; we match the FTS rowids against this app's logs. The
// version filter is applied DURING the join (before the limit slice), so a
// version-scoped search never loses matches that ranked below an unfiltered
// top-`limit`.
function searchLogs(appId, match, limit, now, version) {
  if (!ftsStmts) return [];
  // Pull a wider FTS candidate set than `limit`, because the contentless index
  // spans all apps: after restricting to this app + liveness fewer may remain.
  const ftsLimit = Math.min(Math.max(limit * 8, limit + 50), 2000);
  let hits;
  try {
    hits = ftsStmts.search.all({ match, limit: ftsLimit });
  } catch {
    // A malformed MATCH expression throws; the route validates/escapes input,
    // so treat any residual parse error as "no results" rather than a 500.
    return [];
  }
  if (hits.length === 0) return [];

  // rowid -> relevance rank (lower is better), preserving FTS order.
  const rankByRowid = new Map();
  for (let i = 0; i < hits.length; i++) {
    if (!rankByRowid.has(hits[i].rowid)) rankByRowid.set(hits[i].rowid, i);
  }

  // Join back: scan this app's live logs and keep the ones whose derived rowid
  // is in the hit set. App log counts are bounded per request by the catalog
  // scale; the version index keeps the per-app scan cheap.
  const appRows = stmts.searchAppRows.all({ app_id: appId, now });
  const matched = [];
  for (const r of appRows) {
    if (version && r.app_version !== version) continue;
    const order = rankByRowid.get(ftsRowId(r.id));
    if (order === undefined) continue;
    matched.push({ row: r, order });
  }
  matched.sort((a, b) => a.order - b.order);
  return matched.slice(0, limit).map((m) => m.row);
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
  resolveAppId,
  upsertApp,
  renameApp,
  setLogFolder,
  listFolders,
  listLogsByFolder,
  listVersions,
  statsByApp,
  enginesByApp,
  statsForApp,
  largestLogs,
  listLogs,
  listLogsBySession,
  listCrashRows,
  listLogsMissingSig,
  getLatestByCode,
  updateCrashSig,
  searchAvailable,
  searchLogs,
  indexLog,
  listLogsMissingFts,
  insertFile,
  getFile,
  deleteFile,
  listExpiredFiles,
  listFilesByLog,
  setFilePin,
  bumpRate,
};
