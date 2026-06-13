'use strict';

// Storage / size dashboard: per-project + per-version totals and largest logs.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';

// Varied (low-compressibility) text of roughly `n` lines so gzipped sizes differ.
function body(n) {
  const parts = [];
  for (let i = 0; i < n; i++) parts.push('line ' + i + ' payload-' + (i * 7919 % 1000));
  return parts.join('\n');
}

async function ingest(overrides) {
  const r = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody(overrides) });
  assert.equal(r.status, 201, `ingest failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

let bigId;
before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'appone', name: 'App One' });
  ctx.addApp({ appId: 'apptwo', name: 'App Two' });
  ctx.addApp({ appId: 'emptyapp', name: 'Empty App' });

  await ingest({ appId: 'appone', appVersion: '1.0.0', logText: body(50) });
  bigId = await ingest({ appId: 'appone', appVersion: '1.0.0', logText: body(2000) });
  await ingest({ appId: 'appone', appVersion: '1.1.0', logText: body(300) });
  await ingest({ appId: 'apptwo', appVersion: '1.0.0', logText: body(40) });

  // Pin the big log so pinnedCount is exercised.
  const p = await req(ctx.baseUrl, '/api/logs/' + bigId + '/pin', { method: 'POST', body: { pin: true } });
  assert.equal(p.status, 200);
});
after(() => ctx.close());

test('GET /browse exposes per-project totals and a totals rollup', async () => {
  const r = await req(ctx.baseUrl, '/browse?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  const byId = new Map(r.body.projects.map((p) => [p.appId, p]));

  assert.equal(byId.get('appone').logCount, 3);
  assert.ok(byId.get('appone').totalBytes > 0);
  assert.equal(byId.get('appone').pinnedCount, 1);

  // Registered but log-less app defaults to zeros (proves the listApps merge).
  assert.equal(byId.get('emptyapp').logCount, 0);
  assert.equal(byId.get('emptyapp').totalBytes, 0);
  assert.equal(byId.get('emptyapp').pinnedCount, 0);

  assert.equal(r.body.totals.logCount, 4);
  assert.equal(r.body.totals.pinnedCount, 1);
  assert.ok(r.body.totals.totalBytes > 0);
});

test('GET /browse/:appId exposes version sizes, app totals and largest logs', async () => {
  const r = await req(ctx.baseUrl, '/browse/appone?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);

  assert.equal(r.body.totals.logCount, 3);
  assert.ok(r.body.totals.totalBytes > 0);

  const v100 = r.body.versions.find((v) => v.version === '1.0.0');
  assert.equal(v100.count, 2);
  assert.equal(v100.logCount, 2);
  assert.ok(v100.totalBytes > 0);
  assert.equal(v100.pinnedCount, 1);

  assert.ok(Array.isArray(r.body.largestLogs));
  assert.ok(r.body.largestLogs.length <= 5 && r.body.largestLogs.length >= 1);
  // Descending by size, and the big log is on top.
  for (let i = 1; i < r.body.largestLogs.length; i++) {
    assert.ok(r.body.largestLogs[i - 1].logBytes >= r.body.largestLogs[i].logBytes);
  }
  assert.equal(r.body.largestLogs[0].id, bigId);
});

test('unknown app -> 404', async () => {
  const r = await req(ctx.baseUrl, '/browse/nope?format=json&token=' + VIEWER);
  assert.equal(r.status, 404);
});
