'use strict';

// POST /api/logs/:id/pin  body: { "pin": true | false }
//
// Pinning (CONTRACT section 4):
//   - pin:true  -> expires_at = null, pinned = true. Open by link: anyone with
//                  the (unguessable) id may pin, which is handy for testers.
//   - pin:false -> unpin. This SHRINKS the log's lifetime back to a finite
//                  expiry. Open by default (anyone with the link may unpin,
//                  mirroring pin); set UNPIN_REQUIRES_ADMIN=1 to restrict it to
//                  admin-token holders (Authorization: Bearer <admin>).
//
// On unpin we must recompute an expires_at, because while pinned the row had
// expires_at = null. We base it on the original created_at plus the app's
// retention (clamped to the app ceiling), falling back to the default policy.

const auth = require('../auth');
const db = require('../db');
const config = require('../config');
const { readJsonBody, sendJson, sendError } = require('../util/http');
const { getLiveLog, notFoundJson } = require('./shared');

// Clamp a day count into [1, maxDays].
function clampDays(days, maxDays) {
  if (!Number.isFinite(days)) return null;
  return Math.min(Math.max(Math.trunc(days), 1), maxDays);
}

// Compute the expiry ISO string for an unpinned log: created_at + retention.
function recomputeExpiry(row) {
  const app = db.getApp(row.app_id);
  const maxDays = app ? app.max_retention_days : config.maxRetentionDays;
  let days = app ? app.retention_days : config.defaultRetentionDays;
  days = clampDays(days, maxDays) || config.defaultRetentionDays;

  const created = new Date(row.created_at);
  const base = Number.isNaN(created.getTime()) ? new Date() : created;
  const expires = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  return expires.toISOString();
}

async function pin(req, res, params) {
  // We look up the row directly (not getLiveLog) for unpin/diagnostics, but
  // for the public pin path we still hide expired logs behind the uniform 404.
  const row = getLiveLog(params.id);
  if (!row) return notFoundJson(res);

  let body;
  try {
    body = await readJsonBody(req, 4096);
  } catch (err) {
    const code = err && err.code;
    if (code === 'PAYLOAD_TOO_LARGE') {
      return sendError(res, 413, 'payload_too_large', 'Body too large');
    }
    return sendError(res, 400, 'bad_request', 'Invalid JSON body');
  }

  if (typeof body.pin !== 'boolean') {
    return sendError(res, 400, 'bad_request', 'Field "pin" must be a boolean');
  }

  if (body.pin === true) {
    // Pin: open by link. expires_at = null, pinned = 1.
    db.setPin(row.id, 1, null);
    return sendJson(res, 200, { id: row.id, pinned: true, expiresAt: null });
  }

  // Unpin. Open by default (anyone with the link, like pin); when
  // UNPIN_REQUIRES_ADMIN is set, only admin-token holders may unpin.
  if (config.unpinRequiresAdmin) {
    const token = auth.parseBearer(req.headers['authorization']);
    if (!auth.isAdmin(token)) {
      return sendError(res, 403, 'forbidden', 'Unpin requires admin token');
    }
  }

  const expiresAt = recomputeExpiry(row);
  db.setPin(row.id, 0, expiresAt);
  return sendJson(res, 200, { id: row.id, pinned: false, expiresAt });
}

module.exports = { pin };
