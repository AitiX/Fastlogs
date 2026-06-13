'use strict';

// Pin / unpin policy - RESTRICTED mode (UNPIN_REQUIRES_ADMIN=1).
//
// With the flag on, UNPINNING requires the admin token ("only some can unpin"),
// while PINNING stays open to anyone with the link. This file sets the env BEFORE
// requiring the server (config reads env once); it runs in its own child process
// under `node --test`, so the flag does not leak into the default-mode test.

process.env.UNPIN_REQUIRES_ADMIN = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const ADMIN = 'admin-test-token'; // matches helpers.setup()
let logId;

before(async () => {
  await ctx.ready;
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

test('pin stays open even with UNPIN_REQUIRES_ADMIN=1 (no token)', async () => {
  const r = await req(ctx.baseUrl, `/api/logs/${logId}/pin`, { method: 'POST', body: { pin: true } });
  assert.equal(r.status, 200, `pin should stay open: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.pinned, true);
});

test('unpin WITHOUT admin token is forbidden when UNPIN_REQUIRES_ADMIN=1', async () => {
  const r = await req(ctx.baseUrl, `/api/logs/${logId}/pin`, { method: 'POST', body: { pin: false } });
  assert.equal(r.status, 403, `expected 403, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.error, 'forbidden');
});

test('unpin WITH admin token succeeds when UNPIN_REQUIRES_ADMIN=1', async () => {
  const r = await req(ctx.baseUrl, `/api/logs/${logId}/pin`, {
    method: 'POST',
    body: { pin: false },
    headers: { authorization: `Bearer ${ADMIN}` },
  });
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.pinned, false);
  assert.ok(r.body.expiresAt, 'unpinned log must get a finite expiry back');
});
