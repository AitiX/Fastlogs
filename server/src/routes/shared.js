'use strict';

// Helpers shared by the HTTP routes.
//
// Centralises three concerns:
//   - the single 404 used for any missing/expired/invalid id (anti-enumeration);
//   - "live log" lookup that treats an expired, non-pinned log as absent;
//   - public link building from config.baseUrl.

const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const config = require('../config');
const { sendText, sendJson, nowUtcIso } = require('../util/http');

// Load the viewer HTML shell once at startup. If it is missing we fail loud
// at first use rather than silently serving an empty page.
const VIEWER_PATH = path.join(config.serverRoot, 'public', 'viewer.html');
let viewerShell = null;
function getViewerShell() {
  if (viewerShell === null) {
    viewerShell = fs.readFileSync(VIEWER_PATH, 'utf8');
  }
  return viewerShell;
}

// The placeholder token inside viewer.html that we replace with the inline
// JSON data island. Must match the token in public/viewer.html exactly.
const VIEWER_PLACEHOLDER = '__FASTLOGS_DATA__';

// Validate an id shape cheaply before hitting the database. Ids are base62 and
// 6+ chars; anything else is definitely not ours, so we 404 without a query.
function isPlausibleId(id) {
  return typeof id === 'string' && /^[0-9A-Za-z]{4,32}$/.test(id);
}

// Return the log row for `id` only if it is "live": it exists and is either
// pinned or not yet expired. Expired non-pinned rows are treated as missing so
// that the public surface behaves as if the sweeper had already removed them.
// Returns undefined when there is no live log.
function getLiveLog(id) {
  if (!isPlausibleId(id)) return undefined;
  const row = db.getLog(id);
  if (!row) return undefined;
  if (row.pinned === 1) return row;
  if (row.expires_at && row.expires_at <= nowUtcIso()) return undefined;
  return row;
}

// Return the standalone-file row for `id` only if it is "live": it exists and
// is either pinned or not yet expired. Mirrors getLiveLog so an expired,
// non-pinned file behaves as if the sweeper had already removed it. Returns
// undefined when there is no live file.
function getLiveFile(id) {
  if (!isPlausibleId(id)) return undefined;
  const row = db.getFile(id);
  if (!row) return undefined;
  if (row.pinned === 1) return row;
  if (row.expires_at && row.expires_at <= nowUtcIso()) return undefined;
  return row;
}

// Public links for a standalone file id, built from the configured base URL.
// `self` is the lightweight HTML viewer; `download` streams the blob as an
// attachment.
function fileLinksFor(id) {
  const base = config.baseUrl;
  const enc = encodeURIComponent(id);
  return {
    self: `${base}/files/${enc}`,
    download: `${base}/files/${enc}/download`,
  };
}

// Shape the public view of one file row for the attachments list. `downloadUrl`
// is RELATIVE so the viewer works regardless of the host serving the page or a
// baseUrl that differs from it.
function publicFileObject(row) {
  return {
    id: row.id,
    name: row.name,
    size: row.size_bytes,
    kind: row.kind || null,
    mime: row.mime || null,
    downloadUrl: `/files/${encodeURIComponent(row.id)}/download`,
  };
}

// Live files attached to a log, shaped for the public attachments list (empty
// array when none). Used by publicLogObject and the viewer data island.
function attachmentsForLog(logId) {
  const rows = db.listFilesByLog(logId, nowUtcIso());
  return rows.map(publicFileObject);
}

// Build the public links object for a log id from the configured base URL.
function linksFor(id, hasShot) {
  const base = config.baseUrl;
  const enc = encodeURIComponent(id);
  const links = {
    self: `${base}/${enc}`,
    raw: `${base}/${enc}/raw`,
  };
  if (hasShot) links.screenshot = `${base}/${enc}/screenshot`;
  return links;
}

// Public URLs for a log's screenshots (0..count-1). Index 0 is /<id>/screenshot
// (back-compat); the rest are /<id>/screenshot/<n>.
function screenshotUrls(id, count) {
  const base = config.baseUrl;
  const enc = encodeURIComponent(id);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(i === 0 ? `${base}/${enc}/screenshot` : `${base}/${enc}/screenshot/${i}`);
  }
  return out;
}

// Single, uniform 404 for the public surface (anti-enumeration). Always the
// same body and status regardless of why the id is not served.
function notFound(res) {
  // X-Robots-Tag keeps any accidental crawl off the index too.
  sendText(res, 404, 'Not found', {
    'X-Robots-Tag': 'noindex, nofollow',
  });
}

// JSON-shaped 404 for the API surface (still uniform, anti-enumeration).
function notFoundJson(res) {
  sendJson(res, 404, { error: 'not_found', message: 'Not found' }, {
    'X-Robots-Tag': 'noindex, nofollow',
  });
}

// Parse a log row's device_json into an object (or {} on absence/parse error).
function parseDevice(row) {
  if (!row.device_json) return {};
  try {
    return JSON.parse(row.device_json);
  } catch {
    return {};
  }
}

// Parse a stored JSON column into a value, returning `fallback` on
// absence/parse error or when the parsed value is not the expected shape.
// `expectArray` selects between array and plain-object validation.
function parseJsonColumn(text, expectArray, fallback) {
  if (!text) return fallback;
  try {
    const v = JSON.parse(text);
    if (expectArray) {
      return Array.isArray(v) ? v : fallback;
    }
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : fallback;
  } catch {
    return fallback;
  }
}

// Shape the public JSON view of a log row (used by /api/logs/:id and the
// inline data island). Does not include the log text; callers add it.
function publicLogObject(row) {
  // shot_count is the source of truth; fall back to has_shot for pre-feature rows.
  const shotCount = row.shot_count > 0 ? row.shot_count : (row.has_shot === 1 ? 1 : 0);
  return {
    id: row.id,
    appId: row.app_id,
    appVersion: row.app_version,
    platform: row.platform,
    title: row.title || null,
    comment: row.comment || null,
    tester: row.tester || null,
    timestampUtc: row.ts_utc,
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    pinned: row.pinned === 1,
    counts: { error: row.cnt_error, warn: row.cnt_warn, log: row.cnt_log },
    logBytes: row.log_bytes,
    // Crash signature for grouping; null for non-crash logs (the '' sentinel is
    // falsy, so both NULL and '' surface as null in the public shape).
    crashSig: row.crash_sig || null,
    // Triage: status enum (defaults to 'new' for pre-triage rows) and free-form
    // tags (empty [] when none).
    status: row.status || 'new',
    tags: parseJsonColumn(row.tags, true, []),
    // Engine name (Unity / GameMaker / ...) of this log, or null when unknown.
    engine: row.engine || null,
    // Redmine: whether the integration is configured (so the viewer can show
    // the button) and the linked issue, if any.
    redmineEnabled: config.redmine.enabled,
    redmineIssue: row.redmine_issue_id
      ? { id: row.redmine_issue_id, url: row.redmine_issue_url || null }
      : null,
    hasScreenshot: row.has_shot === 1,
    screenshotCount: shotCount,
    screenshots: screenshotUrls(row.id, shotCount),
    device: parseDevice(row),
    // Structured context (key->value object) and breadcrumbs (array of
    // { t?, m, lvl? }). Always present so clients have a stable shape: an
    // empty object / empty array when the log carried none.
    context: parseJsonColumn(row.context_json, false, {}),
    breadcrumbs: parseJsonColumn(row.breadcrumbs_json, true, []),
    // Scene snapshot: the raw JSON string the client built (parsed + rendered by
    // the viewer), or null when none. correlationCode is a short debug/await
    // code, or null. Both are passed through verbatim.
    sceneContext: row.scene_context || null,
    correlationCode: row.correlation_code || null,
    // Standalone files attached to this log (SendFile with logId). Always an
    // array; live rows only (pinned or not-yet-expired). downloadUrl is relative.
    attachments: attachmentsForLog(row.id),
    links: linksFor(row.id, row.has_shot === 1),
  };
}

module.exports = {
  getViewerShell,
  VIEWER_PLACEHOLDER,
  isPlausibleId,
  getLiveLog,
  getLiveFile,
  fileLinksFor,
  publicFileObject,
  attachmentsForLog,
  linksFor,
  notFound,
  notFoundJson,
  parseDevice,
  parseJsonColumn,
  publicLogObject,
};
