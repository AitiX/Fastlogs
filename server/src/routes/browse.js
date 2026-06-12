'use strict';

// Catalog (CONTRACT section 3): PlayJoy -> Project(appId) -> version -> Log.
//
//   GET /browse                       -> list of projects (appId + name)
//   GET /browse/:appId                -> versions with per-version counts
//   GET /browse/:appId/:version       -> log records for that app+version
//
// Access is team-wide and gated by the viewer tier. The viewer token may be
// supplied two ways (whichever is convenient for the caller):
//   1. Authorization: Bearer <viewer-or-admin-token>   (preferred for tools)
//   2. ?token=<viewer-or-admin-token>                  (handy in a browser)
// The admin token also satisfies viewer access. Missing/invalid token -> 401.
//
// Content negotiation: a browser (Accept: text/html, no ?format=json) gets the
// single-page catalog UI (public/browse.html); tools (Accept: application/json
// or ?format=json) get JSON. The HTML shell is gated by the SAME viewer/team
// auth as the JSON, so the catalog never leaks without a token.

const fs = require('node:fs');
const path = require('node:path');
const auth = require('../auth');
const db = require('../db');
const config = require('../config');
const { sendJson, sendError, sendText } = require('../util/http');

// Load the catalog HTML shell once at first use. browse.js (loaded by the
// shell) reads window.location.pathname to decide which view to render and
// fetches the JSON endpoints below.
const BROWSE_HTML_PATH = path.join(config.serverRoot, 'public', 'browse.html');
let browseShell = null;
function getBrowseShell() {
  if (browseShell === null) {
    browseShell = fs.readFileSync(BROWSE_HTML_PATH, 'utf8');
  }
  return browseShell;
}

// Does the caller want HTML (a browser) rather than JSON? True when the Accept
// header prefers text/html and the request did not explicitly ask for JSON via
// ?format=json. Tools that send Accept: application/json (or ?format=json) get
// JSON.
function wantsHtml(req, query) {
  if (query && query.get('format') === 'json') return false;
  const accept = String(req.headers['accept'] || '').toLowerCase();
  return accept.includes('text/html');
}

// Serve the catalog HTML shell (browser entry point), gated by viewer auth.
function serveBrowseHtml(res) {
  let html;
  try {
    html = getBrowseShell();
  } catch {
    return sendError(res, 500, 'internal_error', 'Catalog UI unavailable');
  }
  sendText(res, 200, html, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
  });
}

// Resolve a viewer token from header or query, then authorize. Returns true if
// the request may see the catalog. On failure the caller answers 401.
function authorizeViewer(req, query) {
  const headerToken = auth.parseBearer(req.headers['authorization']);
  if (headerToken && auth.isViewer(headerToken)) return true;
  const queryToken = query ? query.get('token') : null;
  if (queryToken && auth.isViewer(queryToken)) return true;
  return false;
}

// GET /browse -> projects (JSON) or the catalog UI (HTML for browsers).
function browseRoot(req, res, params, query) {
  if (!authorizeViewer(req, query)) {
    return sendError(res, 401, 'unauthorized', 'Viewer token required');
  }
  if (wantsHtml(req, query)) return serveBrowseHtml(res);
  const apps = db.listApps().map((a) => ({
    appId: a.app_id,
    name: a.name,
    enabled: a.enabled === 1,
  }));
  sendJson(res, 200, { projects: apps });
}

// GET /browse/:appId -> versions (JSON) or the catalog UI (HTML for browsers).
function browseApp(req, res, params, query) {
  if (!authorizeViewer(req, query)) {
    return sendError(res, 401, 'unauthorized', 'Viewer token required');
  }
  if (wantsHtml(req, query)) return serveBrowseHtml(res);
  const app = db.getApp(params.appId);
  if (!app) {
    // Catalog access is already authorized, so a plain 404 is fine here (no
    // enumeration concern: the caller is a trusted team member).
    return sendError(res, 404, 'not_found', 'Unknown appId');
  }
  const versions = db.listVersions(params.appId).map((v) => ({
    version: v.version,
    count: v.count,
    lastAt: v.last_at,
  }));
  sendJson(res, 200, { appId: app.app_id, name: app.name, versions });
}

// GET /browse/:appId/:version -> log records (JSON) or the catalog UI (HTML).
function browseVersion(req, res, params, query) {
  if (!authorizeViewer(req, query)) {
    return sendError(res, 401, 'unauthorized', 'Viewer token required');
  }
  if (wantsHtml(req, query)) return serveBrowseHtml(res);
  const app = db.getApp(params.appId);
  if (!app) {
    return sendError(res, 404, 'not_found', 'Unknown appId');
  }
  const rows = db.listLogs(params.appId, params.version).map((r) => ({
    id: r.id,
    title: r.title || null,
    time: r.ts_utc,
    createdAt: r.created_at,
    platform: r.platform,
    counts: { error: r.cnt_error, warn: r.cnt_warn, log: r.cnt_log },
    hasScreenshot: r.has_shot === 1,
    pinned: r.pinned === 1,
    expiresAt: r.expires_at || null,
  }));
  sendJson(res, 200, {
    appId: app.app_id,
    name: app.name,
    version: params.version,
    logs: rows,
  });
}

module.exports = { browseRoot, browseApp, browseVersion };
