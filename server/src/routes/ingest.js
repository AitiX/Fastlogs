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
const crashsig = require('../crashsig');

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
    // `text` is the decompressed log used to compute the crash signature.
    return { buf, alreadyGzipped: false, text: logText };
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
    // We keep the decompressed result (`text`) for the crash signature instead
    // of discarding it.
    let decoded;
    try {
      decoded = zlib.gunzipSync(gz, { maxOutputLength: maxBytes });
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
    return { buf: gz, alreadyGzipped: true, text: decoded.toString('utf8') };
  }

  const err = new Error(`Unknown logEncoding: ${logEncoding}`);
  err.code = 'BAD_REQUEST';
  throw err;
}

// ---------------------------------------------------------------------------
// Optional structured fields: context (key->value map) and breadcrumbs (array).
// Both are clamped server-side to bounded sizes so a malformed or oversized
// client cannot bloat storage. Invalid *types* are ignored (treated as absent),
// never a 400, because these fields are optional (CONTRACT section 7).
// ---------------------------------------------------------------------------

// Caps mirror the contract: context ~4KB total / key<=64 / value<=512;
// breadcrumbs 100 items / ~16KB total / lvl in {info,warn,error}.
const CTX_MAX_BYTES = 4 * 1024;
const CTX_MAX_KEY = 64;
const CTX_MAX_VALUE = 512;
const BC_MAX_ITEMS = 100;
const BC_MAX_BYTES = 16 * 1024;
const BC_MAX_TEXT = 512;
const BC_MAX_T = 40; // generous bound for an ISO-8601 timestamp string
const BC_LEVELS = new Set(['info', 'warn', 'error']);

const byteLen = (s) => Buffer.byteLength(s, 'utf8');

// Sanitize the context object into a clamped { string: string } map, or return
// null when the input is not a usable object. Keys/values are coerced to
// strings and individually truncated; entries are added until the running
// UTF-8 byte total would exceed CTX_MAX_BYTES, after which the rest is dropped.
function sanitizeContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  let total = 0;
  let any = false;
  for (const rawKey of Object.keys(raw)) {
    const val = raw[rawKey];
    if (val === null || val === undefined) continue;
    if (typeof val === 'object') continue; // only scalar values are kept
    const key = String(rawKey).slice(0, CTX_MAX_KEY);
    if (key.length === 0) continue;
    const value = String(val).slice(0, CTX_MAX_VALUE);
    const cost = byteLen(key) + byteLen(value);
    if (total + cost > CTX_MAX_BYTES) break;
    out[key] = value;
    total += cost;
    any = true;
  }
  return any ? out : null;
}

// Sanitize the breadcrumbs array into a clamped list of { t?, m, lvl? } items,
// or return null when the input is not a usable array. Items without a usable
// `m` text are skipped; `lvl` is kept only if it is a valid enum value. Stops
// after BC_MAX_ITEMS or once the running UTF-8 byte total exceeds BC_MAX_BYTES.
function sanitizeBreadcrumbs(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  let total = 0;
  for (const item of raw) {
    if (out.length >= BC_MAX_ITEMS) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (item.m === null || item.m === undefined) continue;
    const m = String(item.m).slice(0, BC_MAX_TEXT);
    if (m.length === 0) continue;
    const crumb = { m };
    if (item.t !== null && item.t !== undefined) {
      const t = String(item.t).slice(0, BC_MAX_T);
      if (t.length > 0) crumb.t = t;
    }
    if (item.lvl !== null && item.lvl !== undefined) {
      const lvl = String(item.lvl);
      if (BC_LEVELS.has(lvl)) crumb.lvl = lvl;
    }
    const cost = byteLen(crumb.m) + (crumb.t ? byteLen(crumb.t) : 0) + (crumb.lvl ? byteLen(crumb.lvl) : 0);
    if (total + cost > BC_MAX_BYTES) break;
    out.push(crumb);
    total += cost;
  }
  return out.length ? out : null;
}

// Find a value in an object by a case/separator-insensitive key match (so the
// device JSON casing - EngineVersion / engineVersion / engine_version - does
// not matter).
function findKeyCI(obj, name) {
  if (!obj || typeof obj !== 'object') return undefined;
  const target = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase().replace(/[^a-z0-9]/g, '') === target) return obj[k];
  }
  return undefined;
}

// Derive the engine name from device.application: an explicit `engine` field
// when the client sends one (e.g. GameMaker), else "Unity" when a Unity engine
// version is present. '' when unknown (kept out of the engine catalog views).
function deriveEngine(device) {
  const app = device && device.application;
  const explicit = findKeyCI(app, 'engine');
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim().slice(0, 32);
  const ver = findKeyCI(app, 'engineVersion');
  if (ver != null && String(ver).trim()) return 'Unity';
  return '';
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
  // Optional structured context (key->value) and breadcrumbs (event trail).
  // Sanitized + clamped here; invalid types collapse to null (field omitted).
  const context = sanitizeContext(body.context);
  const breadcrumbs = sanitizeBreadcrumbs(body.breadcrumbs);
  const retentionDaysRaw = body.retentionDays;
  // Screenshots: the new `screenshotsPng` array plus the legacy single
  // `screenshotPng` are collected and validated at step 7.

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
  let logBuf, alreadyGzipped, logTextDecoded;
  try {
    ({ buf: logBuf, alreadyGzipped, text: logTextDecoded } = decodeLogText(logText, logEncoding, config.maxLogBytes));
  } catch (err) {
    if (err.code === 'PAYLOAD_TOO_LARGE') {
      return sendError(res, 413, 'payload_too_large', err.message);
    }
    return sendError(res, 400, 'bad_request', err.message);
  }

  // 7. Collect + validate screenshots: the `screenshotsPng` array (new) and the
  // legacy single `screenshotPng`, capped to config.maxScreenshots. Each is an
  // unprefixed base64 PNG; oversized ones are rejected (413), as before.
  if (body.screenshotPng != null && typeof body.screenshotPng !== 'string') {
    return sendError(res, 400, 'bad_request', 'screenshotPng must be a base64 string');
  }
  const shotStrings = [];
  if (Array.isArray(body.screenshotsPng)) {
    for (const s of body.screenshotsPng) {
      if (typeof s === 'string' && s.length > 0) shotStrings.push(s);
    }
  }
  if (typeof body.screenshotPng === 'string' && body.screenshotPng.length > 0) {
    shotStrings.push(body.screenshotPng);
  }
  const shotBufs = [];
  for (const s of shotStrings.slice(0, config.maxScreenshots)) {
    const buf = Buffer.from(s, 'base64');
    if (buf.length > config.maxScreenshotBytes) {
      return sendError(res, 413, 'payload_too_large', 'Screenshot exceeds size limit');
    }
    shotBufs.push(buf);
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

  let shotCount = 0;
  for (let i = 0; i < shotBufs.length; i++) {
    try {
      await storage.saveShot(id, shotBufs[i], i);
      shotCount += 1;
    } catch (err) {
      // Non-fatal for the log itself; stop at the first failure but keep the
      // contiguous shots already saved (the viewer reads 0..shot_count-1).
      console.error('[ingest] failed to save screenshot', i, err);
      break;
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
    context_json: context ? JSON.stringify(context) : null,
    breadcrumbs_json: breadcrumbs ? JSON.stringify(breadcrumbs) : null,
    // Crash signature for grouping. '' (not null) marks "computed, not a crash"
    // so the lazy backfill never re-scans this log.
    crash_sig: crashsig.computeSignature(logTextDecoded, { topK: config.crashSigTopK }) || '',
    // Engine name (Unity / GameMaker / ...) derived from device.application.
    engine: deriveEngine(device),
    ts_utc: timestampUtc,
    cnt_error: counts.error,
    cnt_warn: counts.warn,
    cnt_log: counts.log,
    log_bytes: logBytes,
    has_shot: shotCount > 0 ? 1 : 0,
    shot_count: shotCount,
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
  const links = linksFor(id, shotCount > 0);
  sendJson(res, 201, {
    id,
    url: links.self,
    rawUrl: links.raw,
    expiresAt,
  });
}

module.exports = { handleIngest };
