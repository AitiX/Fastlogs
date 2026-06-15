'use strict';

// GET /api/await/:appId?code=XX&token=YY
//
// Resolve the most recent LIVE log of an app that carries a given debug/await
// code (its correlation_code, or - as a fallback - the code embedded in the
// free-text comment). Lets a tool block on "the report I just triggered" by
// polling for it; there is no long-poll, the caller polls on an interval.
//
// Viewer-token gated, the same way as the catalog (browse/catalog): the token
// may arrive as `Authorization: Bearer <viewer-or-admin-token>` or as
// `?token=<...>`. Missing/invalid token -> 401.
//
// Response JSON: { found, id, url, rawUrl, createdAt } where found is a bool and
// the rest are null when nothing matches.

const auth = require('../auth');
const db = require('../db');
const { sendJson, sendError, nowUtcIso } = require('../util/http');
const { linksFor } = require('./shared');

// Resolve a viewer token from header or query, then authorize (mirrors browse).
function authorizeViewer(req, query) {
  const headerToken = auth.parseBearer(req.headers['authorization']);
  if (headerToken && auth.isViewer(headerToken)) return true;
  const queryToken = query ? query.get('token') : null;
  if (queryToken && auth.isViewer(queryToken)) return true;
  return false;
}

// GET /api/await/:appId -> the latest live log matching ?code=, or found:false.
function awaitByCode(req, res, params, query) {
  if (!authorizeViewer(req, query)) {
    return sendError(res, 401, 'unauthorized', 'Viewer token required');
  }

  const appId = params.appId;
  if (!appId || typeof appId !== 'string' || !/^[a-z0-9_-]{2,32}$/.test(appId)) {
    return sendError(res, 400, 'bad_request', 'appId must be 2-32 chars [a-z0-9_-]');
  }

  const code = query ? query.get('code') : null;
  if (typeof code !== 'string' || code.length < 1 || code.length > 64) {
    return sendError(res, 400, 'bad_request', 'code is required (1..64 chars)');
  }

  // Resolve the appId through aliases so an await under a renamed project's OLD
  // slug still finds the report: ingest re-keys logs onto the new canonical id,
  // so the old slug must be followed to that id before the lookup. An unknown
  // id resolves to itself (resolveAppId returns null -> the `|| appId` fallback)
  // and simply finds nothing, as before.
  const canonical = db.resolveAppId(appId) || appId;

  const hit = db.getLatestByCode(canonical, code, nowUtcIso());
  if (!hit) {
    return sendJson(res, 200, { found: false, id: null, url: null, rawUrl: null, createdAt: null });
  }

  const links = linksFor(hit.id, false);
  return sendJson(res, 200, {
    found: true,
    id: hit.id,
    url: links.self,
    rawUrl: links.raw,
    createdAt: hit.created_at,
  });
}

module.exports = { awaitByCode };
