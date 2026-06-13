'use strict';

// Triage mutations:
//   POST /api/logs/:id/status   body { "status": "new|triaged|in_progress|fixed|wontfix" }
//   POST /api/logs/:id/tags     body { "tags": ["short", "labels"] }
//
// Open by link by default (anyone with the unguessable log id may triage, like
// pin); set TRIAGE_REQUIRES_ADMIN=1 to require the admin token. Unlike ingest's
// optional context/breadcrumbs (which silently coerce), a malformed triage body
// is a clear 400: triage is an explicit team action.

const auth = require('../auth');
const db = require('../db');
const config = require('../config');
const { readJsonBody, sendJson, sendError } = require('../util/http');
const { getLiveLog, notFoundJson } = require('./shared');

const ALLOWED_STATUSES = new Set(['new', 'triaged', 'in_progress', 'fixed', 'wontfix']);

// Open by default; admin token required when TRIAGE_REQUIRES_ADMIN is set.
function authorizeTriage(req) {
  if (!config.triageRequiresAdmin) return true;
  return auth.isAdmin(auth.parseBearer(req.headers['authorization']));
}

// Normalize a tags array: coerce -> trim -> drop empty -> truncate -> dedupe
// (first wins, case-sensitive) -> cap count. Truncation happens before dedupe,
// so two tags differing only past the length cap collapse to one.
function normalizeTags(raw) {
  const out = [];
  const seen = new Set();
  for (const t of raw) {
    if (t === null || t === undefined) continue;
    const s = String(t).trim().slice(0, config.triageTagMaxLen);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= config.triageTagMaxCount) break;
  }
  return out;
}

// Read+parse the small JSON body; on failure send the response and return
// undefined so the caller stops.
async function readBody(req, res) {
  try {
    return await readJsonBody(req, 4096);
  } catch (err) {
    if (err && err.code === 'PAYLOAD_TOO_LARGE') {
      sendError(res, 413, 'payload_too_large', 'Body too large');
    } else {
      sendError(res, 400, 'bad_request', 'Invalid JSON body');
    }
    return undefined;
  }
}

async function setStatus(req, res, params) {
  if (!authorizeTriage(req)) return sendError(res, 403, 'forbidden', 'Triage requires admin token');
  const row = getLiveLog(params.id);
  if (!row) return notFoundJson(res);

  const body = await readBody(req, res);
  if (body === undefined) return;

  const status = body && body.status;
  if (typeof status !== 'string' || !ALLOWED_STATUSES.has(status)) {
    return sendError(res, 400, 'bad_request', 'status must be one of: ' + [...ALLOWED_STATUSES].join(', '));
  }
  db.setStatus(row.id, status);
  return sendJson(res, 200, { id: row.id, status });
}

async function setTags(req, res, params) {
  if (!authorizeTriage(req)) return sendError(res, 403, 'forbidden', 'Triage requires admin token');
  const row = getLiveLog(params.id);
  if (!row) return notFoundJson(res);

  const body = await readBody(req, res);
  if (body === undefined) return;

  if (!body || !Array.isArray(body.tags)) {
    return sendError(res, 400, 'bad_request', 'tags must be an array of strings');
  }
  const tags = normalizeTags(body.tags);
  db.setTags(row.id, tags.length ? JSON.stringify(tags) : null);
  return sendJson(res, 200, { id: row.id, tags });
}

module.exports = { setStatus, setTags };
