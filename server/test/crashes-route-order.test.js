'use strict';

// Router-ordering invariant: /browse/:appId/crashes must be matched by the
// crashes handler even when an app has a real app_version literally named
// "crashes". This locks browseCrashes being registered before browseVersion.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';

async function ingest(overrides) {
  const r = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody(overrides) });
  assert.equal(r.status, 201, `ingest failed: ${r.status} ${JSON.stringify(r.body)}`);
}

before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'routeapp', name: 'Route App' });
  await ingest({ appId: 'routeapp', appVersion: '1.0.0', counts: { error: 0, warn: 0, log: 1 }, logText: 'normal log' });
  // A log whose app_version is literally "crashes".
  await ingest({ appId: 'routeapp', appVersion: 'crashes', counts: { error: 0, warn: 0, log: 1 }, logText: 'version named crashes' });
});
after(() => ctx.close());

test('GET /browse/:appId/crashes hits the crashes endpoint, not the version listing', async () => {
  const r = await req(ctx.baseUrl, '/browse/routeapp/crashes?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.ok('crashes' in r.body, 'response has crashes[]');
  assert.ok('latestVersion' in r.body, 'response has latestVersion');
  assert.ok(!('logs' in r.body), 'must NOT be the version listing');
});

test('GET /browse/:appId/:version still serves the version listing', async () => {
  const r = await req(ctx.baseUrl, '/browse/routeapp/1.0.0?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.logs), 'version listing has logs[]');
});
