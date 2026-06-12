'use strict';

// Authentication and authorization helpers.
//
// Three tiers exist:
//   - ingest:  per-app bearer token (validated against apps.token_hash);
//   - admin:   single ADMIN_TOKEN from config (unpin, delete, manage apps);
//   - viewer:  single VIEWER_TOKEN from config (team catalog access).
//
// Tokens are never stored in plaintext: app tokens are kept as a sha256 hash.
// Comparisons use crypto.timingSafeEqual to avoid timing side channels.

const crypto = require('node:crypto');
const config = require('./config');
const db = require('./db');

// Hash a token (or any string) with sha256, returning lowercase hex.
function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

// Constant-time string comparison. Returns false for length mismatch without
// leaking the mismatch position. Empty expected value is treated as "disabled"
// by callers (see isAdmin/isViewer) rather than here.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Extract a bearer token from an Authorization header value.
// Returns the token string, or null if the header is missing/malformed.
function parseBearer(headerValue) {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  return m ? m[1].trim() : null;
}

// Validate an ingest request for a given appId and Authorization header value.
//
// Returns { ok, app, code } where:
//   - ok:   true if the request may proceed;
//   - app:  the app row when found (even on failure, for diagnostics);
//   - code: one of 'ok' | 'forbidden' | 'unauthorized' (matches CONTRACT codes).
//
// Rules (per CONTRACT section 1):
//   - unknown or disabled appId            -> forbidden;
//   - app has a token but none provided    -> unauthorized;
//   - app has a token and it mismatches    -> forbidden;
//   - app has no token                     -> ok (open ingest for that app).
function validateIngest(appId, bearer) {
  const app = db.getApp(appId);
  if (!app || app.enabled !== 1) {
    return { ok: false, app: app || null, code: 'forbidden' };
  }

  const token = parseBearer(bearer);

  // App requires a token.
  if (app.token_hash) {
    if (!token) return { ok: false, app, code: 'unauthorized' };
    if (!safeEqual(sha256(token), app.token_hash)) {
      return { ok: false, app, code: 'forbidden' };
    }
    return { ok: true, app, code: 'ok' };
  }

  // App has no token: ingest is open for it.
  return { ok: true, app, code: 'ok' };
}

// True if the provided raw token matches the configured admin token.
// If ADMIN_TOKEN is empty, admin auth is considered disabled and this returns
// false (admin-only routes should then be unreachable / refuse in production).
function isAdmin(token) {
  if (!config.adminToken) return false;
  const t = token == null ? '' : String(token);
  return safeEqual(t, config.adminToken);
}

// True if the provided raw token matches the configured viewer token.
// Admin token also satisfies viewer access. Empty VIEWER_TOKEN disables the
// viewer tier (returns false unless the token is the admin token).
function isViewer(token) {
  if (isAdmin(token)) return true;
  if (!config.viewerToken) return false;
  const t = token == null ? '' : String(token);
  return safeEqual(t, config.viewerToken);
}

module.exports = {
  sha256,
  safeEqual,
  parseBearer,
  validateIngest,
  isAdmin,
  isViewer,
};
