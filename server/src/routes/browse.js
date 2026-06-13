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
const storage = require('../storage');
const crashsig = require('../crashsig');
const version = require('../util/version');
const { sendJson, sendError, sendText, nowUtcIso } = require('../util/http');
const { parseJsonColumn } = require('./shared');

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
  // Attach per-project storage totals (size, log count, pinned count).
  const statsById = new Map(db.statsByApp().map((s) => [s.app_id, s]));
  const totals = { totalBytes: 0, logCount: 0, pinnedCount: 0 };
  const apps = db.listApps().map((a) => {
    const s = statsById.get(a.app_id) || { totalBytes: 0, logCount: 0, pinnedCount: 0 };
    totals.totalBytes += s.totalBytes;
    totals.logCount += s.logCount;
    totals.pinnedCount += s.pinnedCount;
    return {
      appId: a.app_id,
      name: a.name,
      enabled: a.enabled === 1,
      totalBytes: s.totalBytes,
      logCount: s.logCount,
      pinnedCount: s.pinnedCount,
    };
  });
  sendJson(res, 200, { projects: apps, totals });
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
    logCount: v.count,
    totalBytes: v.totalBytes,
    pinnedCount: v.pinnedCount,
    lastAt: v.last_at,
  }));
  const totals = db.statsForApp(params.appId) || { logCount: 0, totalBytes: 0, pinnedCount: 0 };
  const largestLogs = db.largestLogs(params.appId, config.statsTopN).map((r) => ({
    id: r.id,
    title: r.title || null,
    version: r.app_version,
    platform: r.platform,
    logBytes: r.log_bytes,
    createdAt: r.created_at,
  }));
  sendJson(res, 200, { appId: app.app_id, name: app.name, versions, totals, largestLogs });
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
    logBytes: r.log_bytes,
    hasScreenshot: r.has_shot === 1,
    pinned: r.pinned === 1,
    status: r.status || 'new',
    tags: parseJsonColumn(r.tags, true, []),
    expiresAt: r.expires_at || null,
  }));
  sendJson(res, 200, {
    appId: app.app_id,
    name: app.name,
    version: params.version,
    logs: rows,
  });
}

// The distinct app version immediately below `latest` (by version order), or
// null if `latest` is the only/lowest version. Used to detect a regression
// (a crash absent from the preceding version but back in the latest one).
function precedingDistinctVersion(allVersions, latest) {
  let best = null;
  for (const v of allVersions) {
    if (version.compareVersions(v, latest) >= 0) continue;
    if (best === null || version.compareVersions(v, best) > 0) best = v;
  }
  return best;
}

// GET /browse/:appId/crashes -> crash groups (JSON) or the catalog UI (HTML).
// Groups this app's live crash logs by stack signature and, per group, reports
// count, distinct testers, versions, first/last seen, and a new/regression flag
// (a crash that first appears in - or returns to - the latest version).
async function browseCrashes(req, res, params, query) {
  if (!authorizeViewer(req, query)) {
    return sendError(res, 401, 'unauthorized', 'Viewer token required');
  }
  if (wantsHtml(req, query)) return serveBrowseHtml(res);
  const app = db.getApp(params.appId);
  if (!app) {
    return sendError(res, 404, 'not_found', 'Unknown appId');
  }

  // Lazy backfill: compute crash_sig for a bounded batch of pre-feature logs
  // (crash_sig IS NULL) so old logs join groups without a destructive
  // migration. '' marks "computed, not a crash" so we never re-scan it.
  const batch = config.crashRecomputeBatch;
  if (batch > 0) {
    const missing = db.listLogsMissingSig(params.appId, batch);
    for (const r of missing) {
      let sig = '';
      try {
        const text = await storage.readLogGz(r.id);
        if (text) sig = crashsig.computeSignature(text, { topK: config.crashSigTopK }) || '';
      } catch {
        sig = '';
      }
      db.updateCrashSig(r.id, sig);
    }
  }

  const now = nowUtcIso();
  const rows = db.listCrashRows(params.appId, now);

  // Latest version across ALL app logs (not just crash rows): a version that
  // shipped with zero crashes must not make a later crash look falsely "new".
  const allVersions = db.listVersions(params.appId).map((v) => v.version);
  let latestVersion = null;
  for (const v of allVersions) {
    if (latestVersion === null || version.compareVersions(v, latestVersion) > 0) latestVersion = v;
  }
  const precedingVersion = latestVersion !== null ? precedingDistinctVersion(allVersions, latestVersion) : null;

  // Group rows by signature.
  const groups = new Map();
  for (const r of rows) {
    let g = groups.get(r.crash_sig);
    if (!g) { g = []; groups.set(r.crash_sig, g); }
    g.push(r);
  }

  const crashes = [];
  for (const [sig, members] of groups) {
    // Oldest-first by version then created_at; first = earliest, last = newest.
    members.sort((a, b) => version.compareVersions(a.app_version, b.app_version, a.created_at, b.created_at));
    const first = members[0];
    const last = members[members.length - 1];

    const versions = [];
    const seenV = new Set();
    const testers = new Set();
    for (const m of members) {
      if (!seenV.has(m.app_version)) { seenV.add(m.app_version); versions.push(m.app_version); }
      if (m.tester) testers.add(m.tester);
    }

    let isNew = false;
    let kind = null;
    if (latestVersion !== null) {
      const presentInLatest = members.some((m) => version.compareVersions(m.app_version, latestVersion) === 0);
      if (version.compareVersions(first.app_version, latestVersion) === 0) {
        // First ever sighting is the latest version: a brand-new crash.
        isNew = true;
        kind = 'new';
      } else if (presentInLatest && precedingVersion !== null) {
        // Older crash that is back in the latest version: regression only if it
        // skipped the immediately-preceding version (a gap).
        const inPreceding = members.some((m) => version.compareVersions(m.app_version, precedingVersion) === 0);
        if (!inPreceding) { isNew = true; kind = 'regression'; }
      }
    }

    crashes.push({
      sig,
      signature: sig,
      title: last.title || null,
      sampleTitle: last.title || null,
      platform: last.platform || null,
      count: members.length,
      testers: testers.size,
      versions,
      firstSeenVersion: first.app_version,
      firstSeenAt: first.created_at,
      lastSeenVersion: last.app_version,
      lastSeenAt: last.created_at,
      isNew,
      kind,
      sampleLogId: last.id,
      sampleLogIds: members.slice(-5).reverse().map((m) => m.id),
    });
  }

  // New/regression first, then most frequent, then most recent.
  crashes.sort((a, b) =>
    (Number(b.isNew) - Number(a.isNew)) ||
    (b.count - a.count) ||
    (a.lastSeenAt < b.lastSeenAt ? 1 : a.lastSeenAt > b.lastSeenAt ? -1 : 0));

  sendJson(res, 200, { appId: app.app_id, name: app.name, latestVersion, crashes });
}

module.exports = { browseRoot, browseApp, browseVersion, browseCrashes };
