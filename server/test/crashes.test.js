'use strict';

// End-to-end tests for crash grouping: GET /browse/:appId/crashes.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';
const ADMIN = 'admin-test-token';

// Same NullReferenceException crash; only the hex offsets and <assembly> token
// differ between runs (so it must collapse into one signature).
function nre(offset, asm) {
  return [
    '[L] +1.000 [Boot] starting up',
    'Terraf.App:Init()',
    '[E] +12.345 NullReferenceException: Object reference not set to an instance of an object',
    `Game.Player:TakeDamage (System.Int32 amount) [0x${offset}] in <${asm}>:0`,
    `Game.Combat:Resolve () [0x00aaa] in <${asm}>:0`,
  ].join('\n');
}
const IOOB = [
  '[E] +3.100 IndexOutOfRangeException: Index was outside the bounds of the array.',
  'Game.Inventory:Get (System.Int32 slot) [0x00001] in <a1>:0',
].join('\n');

async function ingest(overrides) {
  const r = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody(overrides) });
  assert.equal(r.status, 201, `ingest failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

let nreId1;
before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'crashapp', name: 'Crash App' });
  nreId1 = await ingest({ appId: 'crashapp', appVersion: '1.0.0', tester: 'Jane', title: 'nre', counts: { error: 1, warn: 0, log: 2 }, logText: nre('00012', 'a1') });
  await ingest({ appId: 'crashapp', appVersion: '1.0.0', tester: 'Bob', title: 'nre', counts: { error: 1, warn: 0, log: 1 }, logText: nre('000ff', 'z9') });
  await ingest({ appId: 'crashapp', appVersion: '1.1.0', tester: 'Bob', title: 'ioob', counts: { error: 1, warn: 0, log: 0 }, logText: IOOB });
  await ingest({ appId: 'crashapp', appVersion: '1.0.0', tester: 'Jane', title: 'info', counts: { error: 0, warn: 0, log: 3 }, logText: 'plain info log, no error here' });
});
after(() => ctx.close());

test('identical crashes collapse into one group; non-crash excluded', async () => {
  const r = await req(ctx.baseUrl, '/browse/crashapp/crashes?format=json&token=' + VIEWER);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(Array.isArray(r.body.crashes));
  assert.equal(r.body.crashes.length, 2, 'NRE group + IOOR group, info excluded');

  const nreG = r.body.crashes.find((c) => c.title === 'nre');
  assert.ok(nreG, 'NRE group present');
  assert.equal(nreG.count, 2);
  assert.match(nreG.signature, /^[0-9a-f]{12}$/);
  assert.equal(nreG.sig, nreG.signature);
  assert.ok(nreG.versions.includes('1.0.0'));
  assert.ok(nreG.testers >= 1);
  assert.ok(nreG.sampleLogIds.length >= 1 && nreG.sampleLogIds.length <= 5);
  assert.ok(nreG.firstSeenAt <= nreG.lastSeenAt);

  assert.ok(!r.body.crashes.some((c) => c.title === 'info'), 'non-crash not grouped');
});

test('different exception is a separate group', async () => {
  const r = await req(ctx.baseUrl, '/browse/crashapp/crashes?format=json&token=' + VIEWER);
  const a = r.body.crashes.find((c) => c.title === 'nre');
  const b = r.body.crashes.find((c) => c.title === 'ioob');
  assert.ok(a && b);
  assert.notEqual(a.signature, b.signature);
  assert.equal(b.count, 1);
});

test('auth: no token 401, viewer 200, admin 200', async () => {
  assert.equal((await req(ctx.baseUrl, '/browse/crashapp/crashes?format=json')).status, 401);
  assert.equal((await req(ctx.baseUrl, '/browse/crashapp/crashes?format=json&token=' + VIEWER)).status, 200);
  assert.equal((await req(ctx.baseUrl, '/browse/crashapp/crashes?format=json&token=' + ADMIN)).status, 200);
});

test('unknown app -> 404', async () => {
  const r = await req(ctx.baseUrl, '/browse/nope/crashes?format=json&token=' + VIEWER);
  assert.equal(r.status, 404);
});

test('lazy recompute: a crash_sig NULL log is re-signed on access and rejoins its group', async () => {
  // Force a pre-feature state: clear the stored signature of one NRE log.
  ctx.db.db.prepare('UPDATE logs SET crash_sig = NULL WHERE id = ?').run(nreId1);
  const r = await req(ctx.baseUrl, '/browse/crashapp/crashes?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  const nreG = r.body.crashes.find((c) => c.title === 'nre');
  assert.ok(nreG, 'NRE group present after recompute');
  assert.equal(nreG.count, 2, 'recompute restored the cleared log into its group');
});

test('HTML negotiation: browser Accept gets the catalog shell (still token-gated)', async () => {
  const noTok = await req(ctx.baseUrl, '/browse/crashapp/crashes', { headers: { accept: 'text/html' } });
  assert.equal(noTok.status, 401);
  const r = await req(ctx.baseUrl, '/browse/crashapp/crashes?token=' + VIEWER, { headers: { accept: 'text/html' } });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type'] || ''), /text\/html/);
});
