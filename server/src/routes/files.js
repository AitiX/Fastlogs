'use strict';

// Standalone file uploads (FastLogs SendFile / SendFolder).
//
//   POST /api/files          - upload one file as JSON + base64, get a short link.
//   GET  /files/:id/download - stream the stored blob as an attachment.
//   GET  /files/:id          - lightweight HTML viewer (name / size / Download).
//
// A "file" here is opaque bytes: any binary, or a .zip the client built from a
// folder. Unlike logs, the blob is stored VERBATIM (no gzip) and is NEVER
// PII-scrubbed - scrubbing applies only to log text/context/breadcrumbs. The
// only protection is the size cap (config.maxFileBytes on the DECODED size).
//
// Transport mirrors screenshots: JSON with a base64 field, on a DEDICATED
// endpoint (not inside the log report). Because the blob can be far larger than
// a log, the request body is read with config.maxFileBodyBytes (NOT the smaller
// maxPayloadBytes), sized for the base64 + JSON envelope around the cap.

const crypto = require('node:crypto');
const config = require('../config');
const db = require('../db');
const { newId } = require('../id');
const storage = require('../storage');
const { validateIngest } = require('../auth');
const ratelimit = require('../ratelimit');
const {
  sendJson, sendText, sendError, readJsonBody, nowUtcIso,
} = require('../util/http');
const {
  getLiveFile, fileLinksFor, notFound,
} = require('./shared');

// Valid platform enum (kept in sync with ingest.js / CONTRACT section 1).
const VALID_PLATFORMS = new Set([
  'WebGL', 'Android', 'iOS', 'Windows', 'macOS', 'Linux',
  'GameMaker', 'PS4', 'PS5', 'Switch', 'Xbox', 'Other',
]);

// Allowed `kind` hints (free-form classification for the viewer; anything else
// collapses to null so a bogus value can never break rendering).
const VALID_KINDS = new Set(['file', 'folder', 'save', 'screenshot', 'archive', 'other']);

// Rate-limit windows/limits. Files are heavier than logs, so the per-minute
// allowance is lower than ingest's.
const RL_WINDOW_SEC = 60;
const RL_IP_LIMIT = 20;   // per ip per minute
const RL_APP_LIMIT = 40;  // per app per minute

// Compute an anonymous ip hash (sha256 of salt|ip), same scheme as ingest.
function hashIp(ip) {
  const salt = config.ipSalt || 'noop';
  return crypto.createHash('sha256').update(salt + '|' + (ip || ''), 'utf8').digest('hex').slice(0, 16);
}

// Resolve the real client IP behind the documented nginx proxy (see ingest.js).
function clientIp(req) {
  if (config.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
    const xrip = String(req.headers['x-real-ip'] || '').trim();
    if (xrip) return xrip;
  }
  return (req.socket && req.socket.remoteAddress) || '0.0.0.0';
}

// Clamp retentionDays to [1, app.max_retention_days].
function clampRetention(requested, appMax) {
  const days = Number.isFinite(requested) ? Math.round(requested) : config.defaultRetentionDays;
  const max = Number.isFinite(appMax) ? appMax : config.maxRetentionDays;
  return Math.max(1, Math.min(days, max));
}

// Compute expires_at ISO string from a created_at ISO string and retention days.
function addDays(isoBase, days) {
  const d = new Date(isoBase);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

// Sanitize a stored file name to a safe basename: strip any path separators and
// control chars, clamp length, and fall back to a generic name when empty.
function sanitizeName(raw) {
  let name = String(raw == null ? '' : raw);
  // Drop directory components from either separator style.
  name = name.replace(/[\\/]+/g, '/').split('/').pop() || '';
  // Remove control chars and a few characters that break Content-Disposition.
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\x00-\x1f\x7f"<>|]/g, '').trim();
  if (name.length === 0) name = 'file.bin';
  return name.slice(0, 200);
}

// Build a Content-Disposition value with an ASCII fallback plus an RFC 5987
// UTF-8 filename* so non-ASCII names survive. The ASCII fallback strips any
// non-ASCII to a safe placeholder.
function contentDisposition(name) {
  const asciiFallback = name.replace(/[^\x20-\x7e]/g, '_') || 'file.bin';
  const encoded = encodeURIComponent(name);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

// Format a byte count for the lightweight standalone viewer.
function fmtBytes(n) {
  if (n == null || isNaN(n) || n < 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// HTML-escape for the standalone viewer (the name is the only dynamic text).
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// POST /api/files - upload one file (JSON + base64).
// ---------------------------------------------------------------------------

async function handleFileUpload(req, res) {
  // 1. Content-Type guard.
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) {
    return sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json');
  }

  // 2. Read and parse the body with the LARGER file-body limit (not the 8 MB
  // maxPayloadBytes): the blob arrives base64-encoded inside this JSON.
  let body;
  try {
    body = await readJsonBody(req, config.maxFileBodyBytes);
  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') {
      return sendError(res, 413, 'payload_too_large', 'Request body too large');
    }
    return sendError(res, 400, 'bad_request', err.message || 'Invalid request body');
  }

  // 3. Validate required fields.
  const { appId, platform, appVersion, name, fileBase64 } = body;

  if (!appId || typeof appId !== 'string' || !/^[a-z0-9_-]{2,32}$/.test(appId)) {
    return sendError(res, 400, 'bad_request', 'appId must be 2-32 chars [a-z0-9_-]');
  }
  if (!platform || !VALID_PLATFORMS.has(platform)) {
    return sendError(res, 400, 'bad_request', `platform must be one of: ${[...VALID_PLATFORMS].join(', ')}`);
  }
  if (!appVersion || typeof appVersion !== 'string') {
    return sendError(res, 400, 'bad_request', 'appVersion is required');
  }
  if (!name || typeof name !== 'string') {
    return sendError(res, 400, 'bad_request', 'name is required');
  }
  if (!fileBase64 || typeof fileBase64 !== 'string') {
    return sendError(res, 400, 'bad_request', 'fileBase64 is required');
  }

  // Optional fields (clamped; bad types collapse to null, never a 400).
  const mime = body.mime != null ? String(body.mime).slice(0, 200) : null;
  const kindRaw = body.kind != null ? String(body.kind) : null;
  const kind = kindRaw && VALID_KINDS.has(kindRaw) ? kindRaw : null;
  const title = body.title != null ? String(body.title).slice(0, 120) : null;
  const tester = body.tester != null ? String(body.tester).slice(0, 120) : null;
  const logId = body.logId != null ? String(body.logId).slice(0, 32) : null;
  const groupId = body.groupId != null ? String(body.groupId).slice(0, 64) : null;
  const retentionDaysRaw = body.retentionDays;

  // 4. Auth: validate app + token (same tiers as ingest).
  let { ok, app, code } = validateIngest(appId, req.headers['authorization']);
  if (!ok) {
    if (code === 'unauthorized') {
      return sendError(res, 401, 'unauthorized', 'Authorization token required');
    }
    return sendError(res, 403, 'forbidden', 'Unknown or disabled app, or invalid token');
  }

  // Auto-register a new app authenticated with the shared team token (mirrors
  // ingest), so a game can upload files before its first log report exists.
  if (code === 'auto_register') {
    try {
      db.upsertApp({
        app_id: appId,
        name: appId,
        token_hash: null,
        retention_days: config.defaultRetentionDays,
        max_retention_days: config.maxRetentionDays,
        sinks_json: null,
        enabled: 1,
        created_at: nowUtcIso(),
      });
      app = db.getApp(appId);
    } catch (err) {
      console.error('[files] auto-register failed:', err);
      return sendError(res, 500, 'internal_error', 'Failed to auto-register app');
    }
  }

  // 5. Rate-limit: per-IP and per-app.
  const ip = clientIp(req);
  const ipHash = hashIp(ip);
  const rlIp = ratelimit.check(`files:ip:${ipHash}`, RL_IP_LIMIT, RL_WINDOW_SEC);
  if (!rlIp.allowed) {
    return sendError(res, 429, 'too_many_requests', 'Rate limit exceeded',
      { 'Retry-After': String(rlIp.retryAfter) });
  }
  const rlApp = ratelimit.check(`files:app:${appId}`, RL_APP_LIMIT, RL_WINDOW_SEC);
  if (!rlApp.allowed) {
    return sendError(res, 429, 'too_many_requests', 'Rate limit exceeded',
      { 'Retry-After': String(rlApp.retryAfter) });
  }

  // 6. Decode base64 and enforce the DECODED-size cap. Buffer.from ignores
  // invalid base64 chars rather than throwing, so an all-garbage string decodes
  // to an empty/short buffer; we reject an empty decode as a bad request.
  const buf = Buffer.from(fileBase64, 'base64');
  if (buf.length === 0) {
    return sendError(res, 400, 'bad_request', 'fileBase64 did not decode to any bytes');
  }
  if (buf.length > config.maxFileBytes) {
    return sendError(res, 413, 'payload_too_large',
      `file exceeds ${config.maxFileBytes} bytes`);
  }

  // 7. Generate a unique id (not colliding with any file id).
  const id = newId((candidate) => !!db.getFile(candidate));

  // 8. Retention + timestamps.
  const createdAt = nowUtcIso();
  const retentionDays = clampRetention(retentionDaysRaw, app.max_retention_days);
  const expiresAt = addDays(createdAt, retentionDays);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const safeName = sanitizeName(name);

  // 9. Store the blob, then the row. Blob first so a row never points at a
  // missing blob; if the DB insert fails we clean the blob up.
  let sizeBytes;
  try {
    sizeBytes = await storage.saveFile(id, buf);
  } catch (err) {
    console.error('[files] failed to save file blob:', err);
    return sendError(res, 500, 'internal_error', 'Failed to store file');
  }

  try {
    db.insertFile({
      id,
      app_id: appId,
      app_version: appVersion,
      platform,
      log_id: logId,
      group_id: groupId,
      name: safeName,
      mime,
      kind,
      size_bytes: sizeBytes,
      sha256,
      title,
      tester,
      created_at: createdAt,
      expires_at: expiresAt,
      pinned: 0,
      ip_hash: ipHash,
    });
  } catch (err) {
    storage.removeFileBlob(id).catch(() => {});
    console.error('[files] DB insert failed:', err);
    return sendError(res, 500, 'internal_error', 'Failed to store file metadata');
  }

  // 10. Respond 201 with absolute links (mirrors the ingest response shape).
  const links = fileLinksFor(id);
  sendJson(res, 201, {
    id,
    url: links.self,
    downloadUrl: links.download,
    expiresAt,
  });
}

// ---------------------------------------------------------------------------
// GET /files/:id/download - stream the blob as an attachment.
// ---------------------------------------------------------------------------

async function fileDownload(req, res, params) {
  const row = getLiveFile(params.id);
  if (!row) return notFound(res);

  const buf = await storage.readFile(row.id);
  if (buf === null) return notFound(res);

  sendText(res, 200, buf, {
    'Content-Type': row.mime || 'application/octet-stream',
    'Content-Disposition': contentDisposition(row.name || `${row.id}.bin`),
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'public, max-age=86400',
  });
}

// ---------------------------------------------------------------------------
// GET /files/:id - lightweight standalone viewer (name / size / Download).
// ---------------------------------------------------------------------------

async function fileViewer(req, res, params) {
  const row = getLiveFile(params.id);
  if (!row) return notFound(res);

  const name = escapeHtml(row.name || `${row.id}.bin`);
  const size = escapeHtml(fmtBytes(row.size_bytes));
  const title = row.title ? escapeHtml(row.title) : '';
  const downloadHref = `/files/${encodeURIComponent(row.id)}/download`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>FastLogs - ${name}</title>
  <link rel="stylesheet" href="/viewer.css">
</head>
<body>
<div class="page">
  <div class="topbar">
    <a class="topbar-logo" id="topbar-logo" href="/browse">Fast<span>Logs</span></a>
    <span class="topbar-sep">/</span>
    <span class="topbar-title">${name}</span>
  </div>
  <div class="file-standalone">
    <div class="file-name">${name}</div>
    ${title ? `<div class="file-title">${title}</div>` : ''}
    <div class="file-meta">${size}</div>
    <a class="btn btn-primary file-download" href="${downloadHref}" download>Download</a>
  </div>
</div>
</body>
</html>`;

  sendText(res, 200, html, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': 'no-store',
  });
}

module.exports = { handleFileUpload, fileDownload, fileViewer };
