'use strict';

// Full-text search over the catalog (CONTRACT section 3a).
//
//   GET /api/search?appId=<id>&q=<query>[&version=<v>][&limit=<n>]
//
// Searches one app's live logs by free text (title, tester, comment, context
// values, scene snapshot and the log body) using the SQLite FTS5 index. Access
// is team-wide and gated by the viewer tier, exactly like /browse: the viewer
// token may be the Authorization bearer or ?token=. Results are returned in the
// catalog "log record" shape (id, title, time, platform, counts, ...) plus a
// short text snippet, ranked by relevance.
//
// The endpoint is JSON-only (a tool/API surface); the catalog HTML shell drives
// it from the browse page. When the SQLite build lacks FTS5 it answers 503.

const db = require('../db');
const config = require('../config');
const storage = require('../storage');
const { sendJson, sendError, nowUtcIso } = require('../util/http');
const { authorizeViewer, catalogRowFromLog } = require('./shared');

// Max raw query length accepted (longer is truncated). Bounds the work the
// tokenizer does and keeps a pathological query from building a huge MATCH.
const MAX_QUERY_LEN = 256;

// Build a safe FTS5 MATCH expression from raw user input.
//
// FTS5 MATCH is its own little query language (column filters, NEAR, AND/OR,
// quotes, prefix '*'). Passing raw user text straight to MATCH is both an
// injection risk and a frequent syntax-error source. Instead we TOKENIZE the
// input into bare words (letters/digits/underscore, plus '.' so dotted type
// names survive) and emit each as a double-quoted phrase, AND-ed together. A
// double-quote inside a token is doubled (FTS5's own escaping) so it can never
// break out of the phrase. A single trailing '*' on a token is preserved as an
// FTS5 prefix match (quoted-phrase + '*' is valid: "term"*), so typing the
// start of a word still finds it. Returns '' when nothing searchable remains.
function buildMatch(raw) {
  const text = String(raw).slice(0, MAX_QUERY_LEN);
  // Split on anything that is not a word char or '.'; keep a trailing '*' on a
  // token by treating '*' as a token boundary we re-attach below.
  const rawTokens = text.split(/[^\p{L}\p{N}_.*]+/u).filter(Boolean);
  const terms = [];
  for (const tok of rawTokens) {
    // A '*' is only meaningful as a trailing prefix marker; strip any others.
    const prefix = tok.endsWith('*');
    let word = tok.replace(/\*/g, '');
    // Drop leading/trailing dots so ".Update" / "Update." index cleanly.
    word = word.replace(/^\.+|\.+$/g, '');
    if (!word) continue;
    const quoted = '"' + word.replace(/"/g, '""') + '"';
    terms.push(prefix ? quoted + '*' : quoted);
    if (terms.length >= 16) break; // cap the term count
  }
  return terms.join(' AND ');
}

// GET /api/search -> { appId, query, version, count, results: [...] }.
async function search(req, res, params, query) {
  if (!authorizeViewer(req, query)) {
    return sendError(res, 401, 'unauthorized', 'Viewer token required');
  }
  if (!db.searchAvailable()) {
    return sendError(res, 503, 'search_unavailable', 'Full-text search is not available on this server');
  }

  const appId = query ? (query.get('appId') || '').trim() : '';
  const q = query ? (query.get('q') || '') : '';
  const versionFilter = query ? (query.get('version') || '').trim() : '';

  if (!appId) {
    return sendError(res, 400, 'bad_request', 'appId is required');
  }
  const app = db.getApp(appId);
  if (!app) {
    return sendError(res, 404, 'not_found', 'Unknown appId');
  }

  const match = buildMatch(q);
  if (!match) {
    // Empty/whitespace/punctuation-only query: no error, just no results.
    return sendJson(res, 200, { appId, query: q, version: versionFilter || null, count: 0, results: [] });
  }

  // Lazy backfill: index a bounded batch of this app's not-yet-indexed logs so
  // pre-feature logs join search without a destructive migration. Mirrors the
  // crashes route's lazy crash_sig backfill. Best-effort: a read/index failure
  // for one log leaves it for a later request (fts_indexed stays 0).
  const batch = config.searchBackfillBatch;
  if (batch > 0) {
    const missing = db.listLogsMissingFts(appId, batch);
    for (const m of missing) {
      let body = '';
      try {
        body = (await storage.readLogGz(m.id)) || '';
      } catch {
        // Transient blob read failure: skip; leave fts_indexed = 0 to retry.
        continue;
      }
      try {
        db.indexLog(m, body);
      } catch {
        // Index write failure: skip this one, continue the batch.
        continue;
      }
    }
  }

  const now = nowUtcIso();
  const limit = config.searchMaxResults;
  // The optional exact-version filter is applied inside the join (before the
  // limit slice) so a version-scoped search keeps all of that version's matches.
  const rows = db.searchLogs(appId, match, limit, now, versionFilter || null);

  // Build a short snippet per result from the log body (the most useful field
  // to preview a match in). Best-effort: a missing/unreadable blob yields no
  // snippet rather than failing the result. The snippet centres on the first
  // matching line.
  const terms = match
    .split(' AND ')
    .map((t) => t.replace(/^"|"\*?$/g, '').toLowerCase())
    .filter(Boolean);

  const results = [];
  for (const r of rows) {
    const out = catalogRowFromLog(r);
    out.snippet = null;
    try {
      const body = await storage.readLogGz(r.id);
      if (body) out.snippet = makeSnippet(body, terms, config.searchSnippetTokens);
    } catch {
      // leave snippet null
    }
    results.push(out);
  }

  sendJson(res, 200, {
    appId,
    query: q,
    version: versionFilter || null,
    count: results.length,
    results,
  });
}

// Build a short single-line snippet around the first line of `body` that
// contains any of `terms` (lowercased). Falls back to the first non-empty line.
// The snippet is clamped to roughly `maxTokens` whitespace tokens so the
// catalog row stays compact. Returns null when the body has no usable text.
function makeSnippet(body, terms, maxTokens) {
  const lines = String(body).split(/\r?\n/);
  let hit = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (hit === null) hit = trimmed; // first non-empty line as fallback
    const low = trimmed.toLowerCase();
    if (terms.some((t) => t && low.indexOf(t) !== -1)) {
      hit = trimmed;
      break;
    }
  }
  if (!hit) return null;
  const tokens = hit.split(/\s+/);
  if (tokens.length <= maxTokens) return hit;
  return tokens.slice(0, maxTokens).join(' ') + ' ...';
}

module.exports = { search, buildMatch };
