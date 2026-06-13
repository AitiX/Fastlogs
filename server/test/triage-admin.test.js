'use strict';

// Triage with TRIAGE_REQUIRES_ADMIN=1: status/tags require the admin token.
// Set the env BEFORE requiring the server (own child process, like
// pin-admin.test.js).

process.env.TRIAGE_REQUIRES_ADMIN = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';
const ADMIN = 'admin-test-token';

let id;
before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
  const ing = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody({}) });
  assert.equal(ing.status, 201);
  id = ing.body.id;
});
after(() => ctx.close());

test('status with no token -> 403 when admin required', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/status', { method: 'POST', body: { status: 'triaged' } });
  assert.equal(r.status, 403);
});

test('status with viewer token -> 403 (viewer not sufficient)', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/status', {
    method: 'POST', body: { status: 'triaged' }, headers: { authorization: 'Bearer ' + VIEWER },
  });
  assert.equal(r.status, 403);
});

test('status with admin token -> 200', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/status', {
    method: 'POST', body: { status: 'triaged' }, headers: { authorization: 'Bearer ' + ADMIN },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'triaged');
});

test('tags with viewer token -> 403; with admin token -> 200', async () => {
  const v = await req(ctx.baseUrl, '/api/logs/' + id + '/tags', {
    method: 'POST', body: { tags: ['x'] }, headers: { authorization: 'Bearer ' + VIEWER },
  });
  assert.equal(v.status, 403);
  const a = await req(ctx.baseUrl, '/api/logs/' + id + '/tags', {
    method: 'POST', body: { tags: ['x'] }, headers: { authorization: 'Bearer ' + ADMIN },
  });
  assert.equal(a.status, 200);
});
