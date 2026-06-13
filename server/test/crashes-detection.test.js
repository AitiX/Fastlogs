'use strict';

// New / regression detection on the crashes endpoint.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';

// Distinct exception types -> distinct signatures. Same text reused across
// versions keeps a stable signature regardless of version.
const crash = (type) => [
  `[E] +1.000 ${type}: boom`,
  `Game.${type}Site:Run () [0x00001] in <a1>:0`,
].join('\n');

async function ingest(overrides) {
  const r = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody(overrides) });
  assert.equal(r.status, 201, `ingest failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'detectapp', name: 'Detect App' });
  // Z: present in every version (continuous).
  for (const v of ['1.0.0', '1.1.0', '1.2.0']) {
    await ingest({ appId: 'detectapp', appVersion: v, title: 'z', counts: { error: 1, warn: 0, log: 0 }, logText: crash('ZException') });
  }
  // Y: in 1.0.0, absent 1.1.0, back in 1.2.0 (regression).
  await ingest({ appId: 'detectapp', appVersion: '1.0.0', title: 'y', counts: { error: 1, warn: 0, log: 0 }, logText: crash('YException') });
  await ingest({ appId: 'detectapp', appVersion: '1.2.0', title: 'y', counts: { error: 1, warn: 0, log: 0 }, logText: crash('YException') });
  // X: only in latest 1.2.0 (new).
  await ingest({ appId: 'detectapp', appVersion: '1.2.0', title: 'x', counts: { error: 1, warn: 0, log: 0 }, logText: crash('XException') });
  // A non-crash log in the latest version (must list but never group).
  await ingest({ appId: 'detectapp', appVersion: '1.2.0', title: 'info', counts: { error: 0, warn: 0, log: 1 }, logText: 'just an info line' });
});
after(() => ctx.close());

test('latestVersion + per-group first/last seen', async () => {
  const r = await req(ctx.baseUrl, '/browse/detectapp/crashes?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.equal(r.body.latestVersion, '1.2.0');
  const z = r.body.crashes.find((c) => c.title === 'z');
  assert.equal(z.firstSeenVersion, '1.0.0');
  assert.equal(z.lastSeenVersion, '1.2.0');
  assert.equal(z.count, 3);
  assert.deepEqual(z.versions.slice().sort(), ['1.0.0', '1.1.0', '1.2.0']);
});

test('crash only in the latest version is kind=new', async () => {
  const r = await req(ctx.baseUrl, '/browse/detectapp/crashes?format=json&token=' + VIEWER);
  const x = r.body.crashes.find((c) => c.title === 'x');
  assert.equal(x.isNew, true);
  assert.equal(x.kind, 'new');
  assert.equal(x.firstSeenVersion, '1.2.0');
});

test('crash absent from preceding version but back in latest is kind=regression', async () => {
  const r = await req(ctx.baseUrl, '/browse/detectapp/crashes?format=json&token=' + VIEWER);
  const y = r.body.crashes.find((c) => c.title === 'y');
  assert.equal(y.isNew, true);
  assert.equal(y.kind, 'regression');
  assert.equal(y.firstSeenVersion, '1.0.0');
  assert.equal(y.lastSeenVersion, '1.2.0');
});

test('crash present in every version is not flagged', async () => {
  const r = await req(ctx.baseUrl, '/browse/detectapp/crashes?format=json&token=' + VIEWER);
  const z = r.body.crashes.find((c) => c.title === 'z');
  assert.equal(z.isNew, false);
  assert.equal(z.kind, null);
});

test('non-crash log lists in the version view but never appears in crashes', async () => {
  const crashes = await req(ctx.baseUrl, '/browse/detectapp/crashes?format=json&token=' + VIEWER);
  assert.ok(!crashes.body.crashes.some((c) => c.title === 'info'));
  const logs = await req(ctx.baseUrl, '/browse/detectapp/1.2.0?format=json&token=' + VIEWER);
  assert.ok(logs.body.logs.some((l) => l.title === 'info'), 'info log present in version listing');
});

test('non-semver versions: deterministic ordering, no 500', async () => {
  ctx.addApp({ appId: 'nightlyapp', name: 'Nightly App' });
  await ingest({ appId: 'nightlyapp', appVersion: 'nightly-2026-06-10', title: 'n', counts: { error: 1, warn: 0, log: 0 }, logText: crash('ZException') });
  await ingest({ appId: 'nightlyapp', appVersion: 'nightly-2026-06-13', title: 'n', counts: { error: 1, warn: 0, log: 0 }, logText: crash('ZException') });
  const r = await req(ctx.baseUrl, '/browse/nightlyapp/crashes?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.equal(r.body.crashes.length, 1);
  assert.equal(r.body.crashes[0].firstSeenVersion, 'nightly-2026-06-10');
  assert.equal(r.body.crashes[0].lastSeenVersion, 'nightly-2026-06-13');
});

test('app with no crashes -> empty array', async () => {
  ctx.addApp({ appId: 'cleanapp', name: 'Clean App' });
  await ingest({ appId: 'cleanapp', appVersion: '1.0.0', counts: { error: 0, warn: 0, log: 1 }, logText: 'no errors at all' });
  const r = await req(ctx.baseUrl, '/browse/cleanapp/crashes?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.crashes, []);
});
