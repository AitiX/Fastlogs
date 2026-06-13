'use strict';

// The catalog (/browse/:appId/:version) JSON exposes each log's byte size
// (logBytes), so the site can show the "weight" of every log.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token'; // matches helpers.setup()

before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
  const ing = await req(ctx.baseUrl, '/api/logs', {
    method: 'POST',
    body: makeIngestBody({ appId: 'testapp', appVersion: '1.0.0', logText: 'hello world log line for size' }),
  });
  assert.equal(ing.status, 201, `ingest failed: ${ing.status} ${JSON.stringify(ing.body)}`);
});

after(() => ctx.close());

test('browse logs JSON includes per-log logBytes (size)', async () => {
  const r = await req(ctx.baseUrl, '/browse/testapp/1.0.0?format=json&token=' + VIEWER, {
    headers: { accept: 'application/json' },
  });
  assert.equal(r.status, 200, `browse failed: ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body.logs) && r.body.logs.length >= 1, 'expected at least one log');
  const log = r.body.logs[0];
  assert.equal(typeof log.logBytes, 'number', 'logBytes must be a number');
  assert.ok(log.logBytes > 0, 'logBytes should be > 0 for a non-empty log');
});
