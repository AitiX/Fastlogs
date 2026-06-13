'use strict';

// Tests for the shared team ingest token and auto-registration.
//
// The shared TEAM_INGEST_TOKEN is a master ingest key valid for ANY app, and
// with ALLOW_AUTO_REGISTER an unknown appId presented with that token is
// auto-created (tokenless) on first ingest.
//
// IMPORTANT: config.js reads env ONCE at first require. helpers.setup() requires
// the server modules, so these env vars MUST be set BEFORE calling setup().
// This file runs in its own child process under `node --test`, so the env is
// isolated from the other test files.

process.env.TEAM_INGEST_TOKEN = 'team-secret-token';
process.env.ALLOW_AUTO_REGISTER = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();

const TEAM_TOKEN = 'team-secret-token';

before(async () => {
  await ctx.ready;
  // A known, tokenless app for the "team token works for any app" case.
  ctx.addApp({ appId: 'knownapp', name: 'Known App' });
});

after(() => ctx.close());

// -------------------------------------------------------------------------
// 1. Team token is valid for an existing app.
// -------------------------------------------------------------------------
test('ingest with team token succeeds for a known app', async () => {
  const res = await req(ctx.baseUrl, '/api/logs', {
    method: 'POST',
    body: makeIngestBody({ appId: 'knownapp' }),
    headers: { authorization: `Bearer ${TEAM_TOKEN}` },
  });
  assert.equal(res.status, 201,
    `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.id, 'response must have id');
});

// -------------------------------------------------------------------------
// 2. Team token + unknown app + ALLOW_AUTO_REGISTER -> app is auto-created.
// -------------------------------------------------------------------------
test('ingest with team token auto-registers an unknown app', async () => {
  const newAppId = 'autoreg-app';

  // Sanity: the app does not exist yet.
  assert.equal(ctx.db.getApp(newAppId), undefined, 'app must not exist before ingest');

  const res = await req(ctx.baseUrl, '/api/logs', {
    method: 'POST',
    body: makeIngestBody({ appId: newAppId }),
    headers: { authorization: `Bearer ${TEAM_TOKEN}` },
  });
  assert.equal(res.status, 201,
    `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);

  // The app row now exists (tokenless, enabled).
  const app = ctx.db.getApp(newAppId);
  assert.ok(app, 'unknown app must be auto-registered');
  assert.equal(app.enabled, 1, 'auto-registered app must be enabled');
  assert.equal(app.token_hash, null, 'auto-registered app must be tokenless');
});

// -------------------------------------------------------------------------
// 3. A wrong/absent team token on an unknown app is rejected.
// -------------------------------------------------------------------------
test('ingest with wrong team token on unknown app is rejected', async () => {
  const res = await req(ctx.baseUrl, '/api/logs', {
    method: 'POST',
    body: makeIngestBody({ appId: 'never-registered' }),
    headers: { authorization: 'Bearer wrong-token' },
  });
  // Unknown app + a (wrong) token present -> forbidden (403).
  assert.equal(res.status, 403,
    `expected 403, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.error, 'forbidden');
});
