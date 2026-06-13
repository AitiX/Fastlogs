'use strict';

// Pin / unpin policy - DEFAULT mode (UNPIN_REQUIRES_ADMIN unset => open).
//
// Pinning a log is always open (anyone with the unguessable link may pin).
// Unpinning is OPEN by default too, mirroring pin. The restrictive mode
// (admin-only unpin) is covered separately in pin-admin.test.js, which runs in
// its own child process so it can set UNPIN_REQUIRES_ADMIN=1 (config reads env
// once per process).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
let logId;

before(async () => {
  await ctx.ready;
  // Tokenless app => open ingest, so we can post a log to pin.
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
  const ing = await req(ctx.baseUrl, '/api/logs', {
    method: 'POST',
    body: makeIngestBody({ appId: 'testapp' }),
  });
  assert.equal(ing.status, 201, `ingest failed: ${ing.status} ${JSON.stringify(ing.body)}`);
  logId = ing.body.id;
  assert.ok(logId, 'need a log id to pin');
});

after(() => ctx.close());

test('pin is open (no token) and sets pinned=true, no expiry', async () => {
  const r = await req(ctx.baseUrl, `/api/logs/${logId}/pin`, { method: 'POST', body: { pin: true } });
  assert.equal(r.status, 200, `pin failed: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.pinned, true);
  assert.equal(r.body.expiresAt, null, 'pinned log must have no expiry');
});

test('unpin is OPEN by default (no token) and recomputes an expiry', async () => {
  const r = await req(ctx.baseUrl, `/api/logs/${logId}/pin`, { method: 'POST', body: { pin: false } });
  assert.equal(r.status, 200, `unpin should be open by default, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.pinned, false);
  assert.ok(r.body.expiresAt, 'unpinned log must get a finite expiry back');
});
