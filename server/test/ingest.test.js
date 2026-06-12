'use strict';

// Tests for POST /api/logs ingest endpoint.
// Covers: 201+valid response, invalid body->400, retention clamp,
// CORS preflight OPTIONS->204, pin changes expires_at, uniform 404,
// sweeper deletes expired and preserves pinned.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();

before(async () => {
  await ctx.ready;
  // Register the default test app (open ingest, no token required).
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
});

after(() => ctx.close());

// -------------------------------------------------------------------------
// 1. Ingest 201 + valid { id, url }
// -------------------------------------------------------------------------
test('POST /api/logs returns 201 with id and url', async () => {
  const body = makeIngestBody();
  const res = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body });

  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.id, 'response must have id');
  assert.ok(res.body.url, 'response must have url');
  assert.ok(res.body.rawUrl, 'response must have rawUrl');
  assert.ok(res.body.expiresAt, 'response must have expiresAt');

  // id must be base62 and >= 4 chars
  assert.match(res.body.id, /^[0-9A-Za-z]{4,}$/, 'id must be base62');

  // url must contain the id
  assert.ok(res.body.url.includes(res.body.id), 'url must contain id');
});

// -------------------------------------------------------------------------
// 2. Invalid JSON -> 400
// -------------------------------------------------------------------------
test('POST /api/logs with missing required field returns 400', async () => {
  // Missing appId
  const body = makeIngestBody({ appId: undefined });
  delete body.appId;
  const res = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body });
  assert.equal(res.status, 400, `expected 400, got ${res.status}`);
  assert.equal(res.body.error, 'bad_request');
});

test('POST /api/logs with invalid platform returns 400', async () => {
  const body = makeIngestBody({ platform: 'Commodore64' });
  const res = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'bad_request');
});

test('POST /api/logs with wrong Content-Type returns 415', async () => {
  const res = await req(ctx.baseUrl, '/api/logs', {
    method: 'POST',
    body: 'not json',
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(res.status, 415);
  assert.equal(res.body.error, 'unsupported_media_type');
});

// -------------------------------------------------------------------------
// 3. Retention clamp
// -------------------------------------------------------------------------
test('POST /api/logs clamps retentionDays to app max_retention_days', async () => {
  // Register app with max_retention_days=7
  ctx.addApp({ appId: 'testapp-clamp', name: 'Clamp Test', maxRetentionDays: 7 });

  const body = makeIngestBody({ appId: 'testapp-clamp', retentionDays: 365 });
  const res = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body });
  assert.equal(res.status, 201);

  // expires_at should be <= now + 8 days (allowing a few seconds of slack)
  const expiresAt = new Date(res.body.expiresAt);
  const maxExpected = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  assert.ok(expiresAt <= maxExpected, `expiresAt ${res.body.expiresAt} should be clamped to ~7 days`);
});

// -------------------------------------------------------------------------
// 4. CORS preflight OPTIONS -> 204
// -------------------------------------------------------------------------
test('OPTIONS /api/logs returns 204 with CORS headers', async () => {
  const res = await req(ctx.baseUrl, '/api/logs', {
    method: 'OPTIONS',
    headers: { origin: 'https://example.com', 'access-control-request-method': 'POST' },
  });
  assert.equal(res.status, 204);
  assert.ok(res.headers['access-control-allow-origin'], 'should have Allow-Origin header');
  assert.ok(res.headers['access-control-allow-methods'], 'should have Allow-Methods header');
});

// -------------------------------------------------------------------------
// 5. Pin changes expires_at
// -------------------------------------------------------------------------
test('POST /api/logs/:id/pin with pin:true sets pinned and clears expiresAt', async () => {
  // First ingest a log.
  const body = makeIngestBody();
  const ingestRes = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body });
  assert.equal(ingestRes.status, 201);
  const { id } = ingestRes.body;

  // Pin it.
  const pinRes = await req(ctx.baseUrl, `/api/logs/${id}/pin`, {
    method: 'POST',
    body: { pin: true },
  });
  assert.equal(pinRes.status, 200, `pin failed: ${JSON.stringify(pinRes.body)}`);
  assert.equal(pinRes.body.pinned, true);
  assert.equal(pinRes.body.expiresAt, null);

  // Verify via meta endpoint.
  const metaRes = await req(ctx.baseUrl, `/api/logs/${id}`);
  assert.equal(metaRes.status, 200);
  assert.equal(metaRes.body.pinned, true);
  assert.equal(metaRes.body.expiresAt, null);
});

// -------------------------------------------------------------------------
// 5b. Real client IP from proxy headers drives a distinct ip_hash
// -------------------------------------------------------------------------
test('ingest derives ip_hash from X-Forwarded-For (per-client, not loopback)', async () => {
  const db = require('../src/db');

  // Two ingests from the SAME test socket (loopback) but DIFFERENT forwarded
  // client IPs must yield DIFFERENT ip_hash values. Before the fix both would
  // collapse to the loopback hash.
  const r1 = await req(ctx.baseUrl, '/api/logs', {
    method: 'POST',
    body: makeIngestBody(),
    headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
  });
  const r2 = await req(ctx.baseUrl, '/api/logs', {
    method: 'POST',
    body: makeIngestBody(),
    headers: { 'x-forwarded-for': '198.51.100.42' },
  });
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);

  const h1 = db.getLog(r1.body.id).ip_hash;
  const h2 = db.getLog(r2.body.id).ip_hash;
  assert.ok(h1, 'ip_hash should be stored');
  assert.ok(h2, 'ip_hash should be stored');
  assert.notEqual(h1, h2, 'different forwarded client IPs must produce different ip_hash');

  // X-Real-IP is used when X-Forwarded-For is absent, and matches the same
  // first-hop client IP from r1, so it must reproduce r1's hash.
  const r3 = await req(ctx.baseUrl, '/api/logs', {
    method: 'POST',
    body: makeIngestBody(),
    headers: { 'x-real-ip': '203.0.113.7' },
  });
  assert.equal(r3.status, 201);
  assert.equal(db.getLog(r3.body.id).ip_hash, h1, 'X-Real-IP fallback must match the same client IP');
});

// -------------------------------------------------------------------------
// 6. Uniform 404 for unknown id
// -------------------------------------------------------------------------
test('GET /<unknownId> returns 404', async () => {
  const res = await req(ctx.baseUrl, '/zzzZZZnonexistent999');
  assert.equal(res.status, 404, `expected 404, got ${res.status}`);
});

test('GET /api/logs/<unknownId> returns 404 JSON', async () => {
  const res = await req(ctx.baseUrl, '/api/logs/zzzZZZnonexistent999');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'not_found');
});

// -------------------------------------------------------------------------
// 7. Sweeper: deletes expired, preserves pinned
// -------------------------------------------------------------------------
test('sweeper deletes expired logs and preserves pinned', async () => {
  const { sweep } = require('../src/sweeper');
  const db = require('../src/db');
  const { sha256 } = require('../src/auth');
  const { nowUtcIso } = require('../src/util/http');

  // Register an app for sweeper tests.
  ctx.addApp({ appId: 'sweeptest', name: 'Sweep Test' });

  // Ingest a log that will expire in the past (expires_at already passed).
  const body = makeIngestBody({ appId: 'sweeptest' });
  const ingestRes = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body });
  assert.equal(ingestRes.status, 201);
  const { id: expiredId } = ingestRes.body;

  // Force expires_at into the past.
  db.setPin(expiredId, 0, '2000-01-01T00:00:00.000Z');

  // Ingest a second log and pin it.
  const body2 = makeIngestBody({ appId: 'sweeptest' });
  const ingest2 = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: body2 });
  assert.equal(ingest2.status, 201);
  const { id: pinnedId } = ingest2.body;
  db.setPin(pinnedId, 1, null);

  // Run the sweeper.
  const result = await sweep(nowUtcIso(), 500);
  assert.ok(result.rowsDeleted >= 1, `sweeper should have deleted >= 1 row, got ${result.rowsDeleted}`);

  // Expired log should be gone.
  const expiredRow = db.getLog(expiredId);
  assert.equal(expiredRow, undefined, 'expired log should be deleted');

  // Pinned log should still exist.
  const pinnedRow = db.getLog(pinnedId);
  assert.ok(pinnedRow, 'pinned log should NOT be deleted');
  assert.equal(pinnedRow.pinned, 1);
});
