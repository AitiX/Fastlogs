'use strict';

// Log folders (CONTRACT section 3c): manual catalog organisation.
//
//   GET  /api/folders?appId=<id>           -> existing folder paths of an app
//   POST /api/folders/move                 -> assign a selection of logs to a folder
//                 body { appId, ids:[logId...], folder }
//
// A log carries an optional `folder` path (segments joined by "/"); the root is
// the absence of a folder (NULL). Folders are NOT a client/ingest concern - they
// are assigned by hand in the catalog (this endpoint), so the catalog can group
// a project's logs (e.g. "release/qa", "investigating") without new tables. A
// folder exists implicitly once a log is placed in it and disappears once the
// last log leaves it.
//
// Access is team-wide and gated by the viewer tier, exactly like /browse and
// /api/search: the viewer token may be the Authorization bearer or ?token=. The
// appId is resolved through aliases, so a renamed project's OLD slug still works.

const db = require('../db');
const config = require('../config');
const { readJsonBody, sendJson, sendError } = require('../util/http');
const { authorizeViewer } = require('./shared');

// The id shape accepted in a move request - same base62 family as everywhere
// else (see shared.isPlausibleId). Kept local so folders.js validates ids it
// is about to move without reaching for unrelated helpers.
const ID_RE = /^[0-9A-Za-z]{4,32}$/;

// Control characters (C0 range + DEL) rejected in a folder path, so a newline /
// tab / NUL can never reach the stored value. Written as explicit code-point
// escapes to stay readable.
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/;

// Normalize + validate a requested folder path. Returns one of:
//   { folder: null }            -> the ROOT (empty/blank/null input);
//   { folder: '<path>' }        -> a clean, bounded path;
//   { error: '<reason>' }       -> rejected (the caller answers 400).
//
// Normalisation: backslashes become "/", runs of slashes collapse, each segment
// is trimmed, and empty segments are dropped. Rejected: any segment that is "."
// or ".." (path traversal), any control character, a path longer than
// folderMaxLen, a depth beyond folderMaxDepth, or a single segment longer than
// folderSegmentMaxLen. A root request (no usable segments) is always accepted.
function normalizeFolder(raw) {
  if (raw === null || raw === undefined) return { folder: null };
  if (typeof raw !== 'string') return { error: 'folder must be a string' };

  // Reject control characters outright before any other shaping.
  if (CONTROL_CHARS_RE.test(raw)) return { error: 'folder contains control characters' };

  // Treat "\" as "/" so a Windows-style path the user typed still nests, then
  // split into trimmed, non-empty segments (this also collapses "//" and
  // strips leading/trailing slashes).
  const segments = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (segments.length === 0) return { folder: null }; // root

  if (segments.length > config.folderMaxDepth) {
    return { error: `folder is too deep (max ${config.folderMaxDepth} levels)` };
  }
  for (const seg of segments) {
    if (seg === '.' || seg === '..') return { error: 'folder must not contain "." or ".." segments' };
    if (seg.length > config.folderSegmentMaxLen) {
      return { error: `a folder segment exceeds ${config.folderSegmentMaxLen} characters` };
    }
  }

  const folder = segments.join('/');
  if (folder.length > config.folderMaxLen) {
    return { error: `folder exceeds ${config.folderMaxLen} characters` };
  }
  return { folder };
}

// GET /api/folders?appId=<id> -> { appId, folders: [...] }.
// Lists the distinct, non-empty folder paths of an app (the catalog builds its
// folder tree from this). The root is implicit and not listed.
function listFolders(req, res, params, query) {
  if (!authorizeViewer(req, query)) {
    return sendError(res, 401, 'unauthorized', 'Viewer token required');
  }
  const requested = query ? (query.get('appId') || '').trim() : '';
  if (!requested) return sendError(res, 400, 'bad_request', 'appId is required');
  const appId = db.resolveAppId(requested);
  if (!appId) return sendError(res, 404, 'not_found', 'Unknown appId');
  return sendJson(res, 200, { appId, folders: db.listFolders(appId) });
}

// POST /api/folders/move -> { appId, folder, moved }.
// Assigns each of `ids` (this app's logs) to `folder` (or to the root when
// folder is empty/blank/null). Ids that are not this app's logs are skipped;
// `moved` reports how many rows actually changed folder. A folder is created
// implicitly the moment the first log lands in it.
async function moveToFolder(req, res, params, query) {
  if (!authorizeViewer(req, query)) {
    return sendError(res, 401, 'unauthorized', 'Viewer token required');
  }

  let body;
  try {
    body = await readJsonBody(req, 64 * 1024);
  } catch (err) {
    if (err && err.code === 'PAYLOAD_TOO_LARGE') {
      return sendError(res, 413, 'payload_too_large', 'Body too large');
    }
    return sendError(res, 400, 'bad_request', 'Invalid JSON body');
  }

  const requested = body && typeof body.appId === 'string' ? body.appId.trim() : '';
  if (!requested) return sendError(res, 400, 'bad_request', 'appId is required');
  const appId = db.resolveAppId(requested);
  if (!appId) return sendError(res, 404, 'not_found', 'Unknown appId');

  if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
    return sendError(res, 400, 'bad_request', 'ids must be a non-empty array of log ids');
  }
  if (body.ids.length > config.folderMoveMaxIds) {
    return sendError(res, 400, 'bad_request', `too many ids (max ${config.folderMoveMaxIds} per request)`);
  }

  const norm = normalizeFolder(body.folder);
  if (norm.error) return sendError(res, 400, 'bad_request', norm.error);
  const folder = norm.folder;

  // Apply each move; only ids that are plausible AND belong to this app change a
  // row (the statement is scoped by app_id). `moved` counts actual changes, so
  // unknown/cross-app ids are silently skipped rather than failing the batch.
  let moved = 0;
  for (const rawId of body.ids) {
    if (typeof rawId !== 'string' || !ID_RE.test(rawId)) continue;
    const info = db.setLogFolder(rawId, appId, folder);
    if (info && info.changes > 0) moved += 1;
  }

  return sendJson(res, 200, { appId, folder, moved });
}

module.exports = { listFolders, moveToFolder, normalizeFolder };
