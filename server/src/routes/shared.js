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

// Shape the public JSON view of a log row (used by /api/logs/:id and the
// inline data island). Does not include the log text; callers add it.
function publicLogObject(row) {
  return {
    id: row.id,
    appId: row.app_id,
    appVersion: row.app_version,
    platform: row.platform,
    title: row.title || null,
    timestampUtc: row.ts_utc,
    createdAt: row.created_at,
    expiresAt: row.expires_at || null,
    pinned: row.pinned === 1,
    counts: { error: row.cnt_error, warn: row.cnt_warn, log: row.cnt_log },
    logBytes: row.log_bytes,
    hasScreenshot: row.has_shot === 1,
    device: parseDevice(row),
    links: linksFor(row.id, row.has_shot === 1),
  };
}

module.exports = {
  getViewerShell,
  VIEWER_PLACEHOLDER,
  isPlausibleId,
  getLiveLog,
  linksFor,
  notFound,
  notFoundJson,
  parseDevice,
  publicLogObject,
};
