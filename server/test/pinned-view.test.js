'use strict';

// Per-app "Pinned" view: GET /browse/:appId/pinned gathers ALL pinned logs of
// one project across every version into one place, newest first. Mirrors the
// crashes/session view tests (auth-gated, alias-resolved, per-app isolated).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';
const ADMIN = 'admin-test-token';

async function ingest(overrides) {
  const r = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody(overrides) });
  assert.equal(r.status, 201, `ingest failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

// Pin a log via the open-by-link pin endpoint (mirrors a Redmine auto-pin / a
// manual pin). Returns nothing; asserts the pin succeeded.
async function pin(id) {
  const r = await req(ctx.baseUrl, `/api/logs/${id}/pin`, { method: 'POST', body: { pin: true } });
  assert.equal(r.status, 200, `pin failed: ${r.status} ${JSON.stringify(r.body)}`);
  assert.equal(r.body.pinned, true);
}

// Two pinned logs across two versions (v1 older, v2 newer), one unpinned log in
// between, plus a pinned log of a SECOND app to prove per-app isolation.
let pinnedV1, pinnedV2, unpinned, otherPinned;
before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'pinapp', name: 'Pin App' });
  ctx.addApp({ appId: 'otherapp', name: 'Other App' });

  pinnedV1 = await ingest({ appId: 'pinapp', appVersion: '1.0.0', title: 'pinned in v1' });
  unpinned = await ingest({ appId: 'pinapp', appVersion: '1.0.0', title: 'not pinned' });
  pinnedV2 = await ingest({ appId: 'pinapp', appVersion: '2.0.0', title: 'pinned in v2' });

  otherPinned = await ingest({ appId: 'otherapp', appVersion: '1.0.0', title: 'other app pinned' });

  // pinnedV2 is ingested last, so it is the newest by created_at.
  await pin(pinnedV1);
  await pin(pinnedV2);
  await pin(otherPinned);
});
after(() => ctx.close());

test('returns exactly the pinned logs, newest first, across all versions', async () => {
  const r = await req(ctx.baseUrl, '/browse/pinapp/pinned?format=json&token=' + VIEWER);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.appId, 'pinapp');
  assert.equal(r.body.name, 'Pin App');
  assert.ok(Array.isArray(r.body.logs));
  const ids = r.body.logs.map((x) => x.id);
  // Both pinned logs, the newest (v2) first; never the unpinned one.
  assert.deepEqual(ids, [pinnedV2, pinnedV1]);
  for (const log of r.body.logs) assert.equal(log.pinned, true);
  assert.ok(!ids.includes(unpinned), 'unpinned log excluded');
});

test('catalog rows carry the version (cross-version view)', async () => {
  const r = await req(ctx.baseUrl, '/browse/pinapp/pinned?format=json&token=' + VIEWER);
  const byId = new Map(r.body.logs.map((x) => [x.id, x]));
  assert.equal(byId.get(pinnedV1).version, '1.0.0');
  assert.equal(byId.get(pinnedV2).version, '2.0.0');
});

test('a different app is isolated', async () => {
  const r = await req(ctx.baseUrl, '/browse/otherapp/pinned?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.logs.map((x) => x.id), [otherPinned]);
});

test('an unpinned log drops out of the view after unpin', async () => {
  // Pin then unpin: the pinned view must reflect the live pinned set.
  await pin(unpinned);
  let r = await req(ctx.baseUrl, '/browse/pinapp/pinned?format=json&token=' + VIEWER);
  assert.ok(r.body.logs.map((x) => x.id).includes(unpinned), 'present while pinned');

  const un = await req(ctx.baseUrl, `/api/logs/${unpinned}/pin`, { method: 'POST', body: { pin: false } });
  assert.equal(un.status, 200, `unpin failed: ${un.status} ${JSON.stringify(un.body)}`);

  r = await req(ctx.baseUrl, '/browse/pinapp/pinned?format=json&token=' + VIEWER);
  assert.ok(!r.body.logs.map((x) => x.id).includes(unpinned), 'gone after unpin');
});

test('auth: no token 401, viewer 200, admin 200', async () => {
  assert.equal((await req(ctx.baseUrl, '/browse/pinapp/pinned?format=json')).status, 401);
  assert.equal((await req(ctx.baseUrl, '/browse/pinapp/pinned?format=json&token=' + VIEWER)).status, 200);
  assert.equal((await req(ctx.baseUrl, '/browse/pinapp/pinned?format=json&token=' + ADMIN)).status, 200);
});

test('unknown app -> 404', async () => {
  const r = await req(ctx.baseUrl, '/browse/nope/pinned?format=json&token=' + VIEWER);
  assert.equal(r.status, 404);
});

test('alias-resolved: an old slug still reaches the pinned view', async () => {
  // Register + pin under an old slug, rename it, then browse the pinned view via
  // the OLD slug: it must resolve to the canonical app and list the pinned log.
  ctx.addApp({ appId: 'oldpin', name: 'Old Pin' });
  const aliasPinned = await ingest({ appId: 'oldpin', appVersion: '1.0.0', title: 'alias pinned' });
  await pin(aliasPinned);
  ctx.db.renameApp('oldpin', 'newpin', 'New Pin');

  const r = await req(ctx.baseUrl, '/browse/oldpin/pinned?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.equal(r.body.appId, 'newpin', 'resolves to the canonical id');
  assert.deepEqual(r.body.logs.map((x) => x.id), [aliasPinned]);
});

test('route order: a version literally named "pinned" still hits the pinned view', async () => {
  // browsePinned must be registered before browseVersion (both 3-segment GET
  // patterns), so an app_version literally "pinned" cannot shadow the endpoint.
  ctx.addApp({ appId: 'rorder', name: 'Route Order' });
  const litId = await ingest({ appId: 'rorder', appVersion: 'pinned', title: 'version named pinned' });
  await pin(litId);

  const r = await req(ctx.baseUrl, '/browse/rorder/pinned?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  // The pinned view shape ({ logs } with no `version` field on the envelope),
  // not the version listing for the version "pinned".
  assert.ok(Array.isArray(r.body.logs), 'pinned view returns logs[]');
  assert.equal(r.body.version, undefined, 'must NOT be the version listing');
  assert.deepEqual(r.body.logs.map((x) => x.id), [litId]);
});

test('empty: an app with no pinned logs returns an empty list (not an error)', async () => {
  ctx.addApp({ appId: 'nopins', name: 'No Pins' });
  await ingest({ appId: 'nopins', appVersion: '1.0.0', title: 'unpinned only' });
  const r = await req(ctx.baseUrl, '/browse/nopins/pinned?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.logs, []);
});

test('HTML negotiation: browser Accept gets the catalog shell (still token-gated)', async () => {
  const noTok = await req(ctx.baseUrl, '/browse/pinapp/pinned', { headers: { accept: 'text/html' } });
  assert.equal(noTok.status, 401);
  const r = await req(ctx.baseUrl, '/browse/pinapp/pinned?token=' + VIEWER, { headers: { accept: 'text/html' } });
  assert.equal(r.status, 200);
  assert.match(String(r.headers['content-type'] || ''), /text\/html/);
});
