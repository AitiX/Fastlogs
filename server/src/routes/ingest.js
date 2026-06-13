'use strict';

// POST /api/logs - log ingest endpoint.
//
// Validates the request, stores the log body and optional screenshot,
// inserts the metadata row, then asynchronously fires configured sinks.
// Returns 201 with { id, url, rawUrl, expiresAt } on success.

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const config = require('../config');
const db = require('../db');
const { newId } = require('../id');
const storage = require('../storage');
const { validateIngest } = require('../auth');
const ratelimit = require('../ratelimit');
const { sendJson, sendError, readJsonBody, nowUtcIso } = require('../util/http');
const { linksFor } = require('./shared');

// Valid platform enum per CONTRACT section 1.
const VALID_PLATFORMS = new Set([
  'WebGL', 'Android', 'iOS', 'Windows', 'macOS', 'Linux',
  'GameMaker', 'PS4', 'PS5', 'Switch', 'Xbox', 'Other',
]);

// Valid logEncoding values.
const VALID_ENCODINGS = new Set(['plain', 'gzip+base64']);

// Compute an anonymous ip hash for rate-limiting and storage. Uses a constant-
// time sha256 of (salt + ip) to avoid reversibility.
function hashIp(ip) {
  const salt = config.ipSalt || 'noop';
  return crypto.createHash('sha256').update(salt + '|' + (ip || ''), 'utf8').digest('hex').slice(0, 16);
}

// Resolve the real client IP. Behind the documented nginx proxy, Node listens
// on 127.0.0.1, so req.socket.remoteAddress is always the loopback address and
// the true client IP arrives via X-Forwarded-For / X-Real-IP. When trustProxy
// is enabled we take the first hop of X-Forwarded-For (the original client),
// then X-Real-IP, and only fall back to the socket address. With trustProxy
// disabled (Node directly exposed) we ignore those spoofable headers.
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

// Validate and decode the logText field. Returns a Buffer ready for storage,
// or throws an error with a human-readable message.
function decodeLogText(logText, logEncoding, maxBytes) {
  if (typeof logText !== 'string' || logText.length === 0) {
    const err = new Error('logText is required');
    err.code = 'BAD_REQUEST';
    throw err;
  }

  if (logEncoding === 'plain') {
    const buf = Buffer.from(logText, 'utf8');
    if (buf.length > maxBytes) {
      const err = new Error(`logText exceeds ${maxBytes} bytes`);
      err.code = 'PAYLOAD_TOO_LARGE';
      throw err;
    }
    return { buf, alreadyGzipped: false };
  }

  if (logEncoding === 'gzip+base64') {
    // Decode base64 first, then treat as already-gzipped.
    let gz;
    try {
      gz = Buffer.from(logText, 'base64');
    } catch {
      const err = new Error('logText is not valid base64');
      err.code = 'BAD_REQUEST';
      throw err;
    }

    // Cheap structural check: a gzip stream starts with the magic bytes
    // 0x1f 0x8b. Reject anything that is clearly not gzip before doing real work.
    if (gz.length < 2 || gz[0] !== 0x1f || gz[1] !== 0x8b) {
      const err = new Error('logText is not a valid gzip stream (bad magic bytes)');
      err.code = 'BAD_REQUEST';
      throw err;
    }

    // Trial decompression bounded by maxBytes. This both validates the gzip
    // payload (so we never persist a corrupt blob) and enforces the
    // MAX_LOG_BYTES ceiling on the *decompressed* log at ingest time
    // (CONTRACT section 6). maxOutputLength makes zlib abort once the output
    // would exceed the limit, so a small "zip bomb" cannot blow up memory.
    try {
      zlib.gunzipSync(gz, { maxOutputLength: maxBytes });
    } catch (e) {
      // RangeError from maxOutputLength => decompressed log too large.
      if (e instanceof RangeError || /maxOutputLength|buffer/i.test(e.message || '')) {
        const err = new Error(`decompressed logText exceeds ${maxBytes} bytes`);
        err.code = 'PAYLOAD_TOO_LARGE';
        throw err;
      }
      const err = new Error('logText is not a valid gzip stream');
      err.code = 'BAD_REQUEST';
      throw err;
    }

    // Valid gzip within limits: persist the gzipped buffer verbatim.
    return { buf: gz, alreadyGzipped: true };
  }

  const err = new Error(`Unknown logEncoding: ${logEncoding}`);
  err.code = 'BAD_REQUEST';
  throw err;
}

// Rate-limit keys and limits (windows 60s = 1 minute, configurable here).
const RL_WINDOW_SEC = 60;
const RL_IP_LIMIT = 60;   // per ip per minute
const RL_APP_LIMIT = 120; // per app per minute

async function handleIngest(req, res) {
  // 1. Content-Type guard.
  const ct = String(req.headers['content-type'] || '');
  if (!ct.includes('application/json')) {
    return sendError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json');
  }

  // 2. Read and parse the body.
  let body;
  try {
    body = await readJsonBody(req, config.maxPayloadBytes);
  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') {
      return sendError(res, 413, 'payload_too_large', 'Request body too large');
    }
    return sendError(res, 400, 'bad_request', err.message || 'Invalid request body');
  }

  // 3. Validate required fields.
  const { appId, platform, appVersion, timestampUtc, counts, logText, logEncoding, device } = body;

  if (!appId || typeof appId !== 'string' || !/^[a-z0-9_-]{2,32}$/.test(appId)) {
    return sendError(res, 400, 'bad_request', 'appId must be 2-32 chars [a-z0-9_-]');
  }
  if (!platform || !VALID_PLATFORMS.has(platform)) {
    return sendError(res, 400, 'bad_request', `platform must be one of: ${[...VALID_PLATFORMS].join(', ')}`);
  }
  if (!appVersion || typeof appVersion !== 'string') {
    return sendError(res, 400, 'bad_request', 'appVersion is required');
  }
  if (!timestampUtc || typeof timestampUtc !== 'string' || isNaN(Date.parse(timestampUtc))) {
    return sendError(res, 400, 'bad_request', 'timestampUtc must be a valid ISO-8601 UTC string');
  }
  if (!counts || typeof counts !== 'object' ||
      !Number.isInteger(counts.error) || !Number.isInteger(counts.warn) || !Number.isInteger(counts.log)) {
    return sendError(res, 400, 'bad_request', 'counts must be an object with integer fields error, warn, log');
  }
  if (!logEncoding || !VALID_ENCODINGS.has(logEncoding)) {
    return sendError(res, 400, 'bad_request', `logEncoding must be one of: ${[...VALID_ENCODINGS].join(', ')}`);
  }
  if (!device || typeof device !== 'object' || Array.isArray(device)) {
    return sendError(res, 400, 'bad_request', 'device must be an object');
  }

  // Optional fields.
  const title = body.title != null ? String(body.title).slice(0, 120) : null;
  // Free-text comment from the tester (issue description). Longer than title.
  const comment = body.comment != null ? String(body.comment).slice(0, 4000) : null;
  // Tester name from the client settings (who submitted this report).
  const tester = body.tester != null ? String(body.tester).slice(0, 120) : null;
  const retentionDaysRaw = body.retentionDays;
  const screenshotPng = body.screenshotPng || null;

  // 4. Auth: validate app + token.
  let { ok, app, code } = validateIngest(appId, req.headers['authorization']);
  if (!ok) {
    if (code === 'unauthorized') {
      return sendError(res, 401, 'unauthorized', 'Authorization token required');
    }
    return sendError(res, 403, 'forbidden', 'Unknown or disabled app, or invalid token');
  }

  // Auto-register: a new app authenticated with the shared team token. Create it
  // (tokenless) on first ingest so new games self-onboard without an admin step.
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
      console.error('[ingest] auto-register failed:', err);
      return sendError(res, 500, 'internal_error', 'Failed to auto-register app');
    }
  }

  // 5. Rate-limit: per-IP and per-app.
  const ip = clientIp(req);
  const ipHash = hashIp(ip);
  const rlIp = ratelimit.check(`ingest:ip:${ipHash}`, RL_IP_LIMIT, RL_WINDOW_SEC);
  if (!rlIp.allowed) {
    return sendError(res, 429, 'too_many_requests', 'Rate limit exceeded',
      { 'Retry-After': String(rlIp.retryAfter) });
  }
  const rlApp = ratelimit.check(`ingest:app:${appId}`, RL_APP_LIMIT, RL_WINDOW_SEC);
  if (!rlApp.allowed) {
    return sendError(res, 429, 'too_many_requests', 'Rate limit exceeded',
      { 'Retry-After': String(rlApp.retryAfter) });
  }

  // 6. Decode log text.
  let logBuf, alreadyGzipped;
  try {
    ({ buf: logBuf, alreadyGzipped } = decodeLogText(logText, logEncoding, config.maxLogBytes));
  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') {
      return sendError(res, 413, 'payload_too_large', err.message);
    }
    return sendError(res, 400, 'bad_request', err.message);
  }

  // 7. Validate screenshot size if provided.
  let shotBuf = null;
  if (screenshotPng) {
    if (typeof screenshotPng !== 'string') {
      return sendError(res, 400, 'bad_request', 'screenshotPng must be a base64 string');
    }
    shotBuf = Buffer.from(screenshotPng, 'base64');
    if (shotBuf.length > config.maxScreenshotBytes) {
      return sendError(res, 413, 'payload_too_large', 'Screenshot exceeds size limit');
    }
  }

  // 8. Generate unique id.
  const id = newId((candidate) => !!db.getLog(candidate));

  // 9. Compute retention and timestamps.
  const createdAt = nowUtcIso();
  const retentionDays = clampRetention(retentionDaysRaw, app.max_retention_days);
  const expiresAt = addDays(createdAt, retentionDays);

  // 10. Store blobs.
  let logBytes;
  try {
    logBytes = await storage.saveLogGz(id, logBuf, alreadyGzipped);
  } catch (err) {
    console.error('[ingest] failed to save log blob:', err);
    return sendError(res, 500, 'internal_error', 'Failed to store log');
  }

  if (shotBuf) {
    try {
      await storage.saveShot(id, shotBuf);
    } catch (err) {
      // Non-fatal for the log itself; remove blob and proceed without screenshot.
      console.error('[ingest] failed to save screenshot:', err);
      shotBuf = null;
    }
  }

  // 11. Insert DB row.
  const row = {
    id,
    app_id: appId,
    platform,
    app_version: appVersion,
    device_json: JSON.stringify(device),
    title,
    comment,
    tester,
    ts_utc: timestampUtc,
    cnt_error: counts.error,
    cnt_warn: counts.warn,
    cnt_log: counts.log,
    log_bytes: logBytes,
    has_shot: shotBuf ? 1 : 0,
    created_at: createdAt,
    expires_at: expiresAt,
    pinned: 0,
    ip_hash: ipHash,
  };

  try {
    db.insertLog(row);
  } catch (err) {
    // Clean up blobs on DB insert failure.
    storage.removeBlobs(id).catch(() => {});
    console.error('[ingest] DB insert failed:', err);
    return sendError(res, 500, 'internal_error', 'Failed to store log metadata');
  }

  // 12. Fire sinks asynchronously (does not block response).
  try {
    const sinks = require('../sinks');
    sinks.dispatch(app, {
      project: appId,
      projectName: app.name,
      version: appVersion,
      platform,
      url: `${config.baseUrl}/${id}`,
      title: title || '',
      counts: { error: counts.error, warn: counts.warn, log: counts.log },
      time: timestampUtc,
    }).catch((err) => {
      console.error('[ingest] sink dispatch error:', err);
    });
  } catch {
    // Sinks module optional; silently skip if not available.
  }

  // 13. Respond 201.
  const links = linksFor(id, !!shotBuf);
  sendJson(res, 201, {
    id,
    url: links.self,
    rawUrl: links.raw,
    expiresAt,
  });
}

module.exports = { handleIngest };
