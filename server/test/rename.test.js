'use strict';

// Project rename + alias: an OLD appId keeps working for ingest, browse and
// search after a rename, and nothing is lost (logs are re-keyed, ids/links
// unchanged). Exercises db.renameApp / db.resolveAppId through the HTTP surface.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';

async function ingest(overrides) {
  const r = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody(overrides) });
  assert.equal(r.status, 201, `ingest failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

let idBeforeRename;
before(async () => {
  await ctx.ready;
  // Register the project under its OLD slug and seed one log, then rename it.
  ctx.addApp({ appId: 'oldgame', name: 'Old Game' });
  idBeforeRename = await ingest({
    appId: 'oldgame', appVersion: '1.0.0',
    title: 'Pre-rename log', logText: 'NullReferenceException xenobladeword',
  });
  // Rename the slug AND the display name. The old slug becomes an alias.
  ctx.db.renameApp('oldgame', 'newgame', 'New Game');
});
after(() => ctx.close());

test('resolveAppId: old slug and new slug both resolve to the new canonical id', () => {
  assert.equal(ctx.db.resolveAppId('newgame'), 'newgame');
  assert.equal(ctx.db.resolveAppId('oldgame'), 'newgame');
  assert.equal(ctx.db.resolveAppId('neverexisted'), null);
});

test('the pre-rename log was re-keyed to the new app (nothing lost)', () => {
  const row = ctx.db.getLog(idBeforeRename);
  assert.ok(row, 'log still exists');
  assert.equal(row.app_id, 'newgame', 'log re-keyed to the canonical id');
});

test('the per-id link is independent of the appId (still works)', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + idBeforeRename);
  assert.equal(r.status, 200);
  assert.equal(r.body.appId, 'newgame');
});

test('ingest under the OLD appId lands in the NEW project', async () => {
  const id = await ingest({ appId: 'oldgame', appVersion: '1.1.0', title: 'Post-rename via old slug' });
  const row = ctx.db.getLog(id);
  assert.equal(row.app_id, 'newgame', 'old-slug ingest stored under the canonical id');
});

test('browse under the OLD appId returns the NEW project', async () => {
  const r = await req(ctx.baseUrl, '/browse/oldgame?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.equal(r.body.appId, 'newgame');
  assert.equal(r.body.name, 'New Game');
  assert.ok(Array.isArray(r.body.versions) && r.body.versions.length >= 1);
});

test('browse version listing under the OLD appId shows the re-keyed logs', async () => {
  const r = await req(ctx.baseUrl, '/browse/oldgame/1.0.0?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.equal(r.body.appId, 'newgame');
  assert.deepEqual(r.body.logs.map((x) => x.id), [idBeforeRename]);
});

test('search under the OLD appId searches the NEW project', async () => {
  const r = await req(ctx.baseUrl, '/api/search?token=' + VIEWER + '&appId=oldgame&q=xenobladeword');
  assert.equal(r.status, 200);
  assert.equal(r.body.appId, 'newgame');
  assert.deepEqual(r.body.results.map((x) => x.id), [idBeforeRename]);
});

test('an unknown alias still 404s on browse and search', async () => {
  const b = await req(ctx.baseUrl, '/browse/ghostgame?format=json&token=' + VIEWER);
  assert.equal(b.status, 404);
  const s = await req(ctx.baseUrl, '/api/search?token=' + VIEWER + '&appId=ghostgame&q=x');
  assert.equal(s.status, 404);
});

test('renaming again chains: the original slug still resolves to the latest id', () => {
  ctx.db.renameApp('newgame', 'final', null);
  assert.equal(ctx.db.resolveAppId('final'), 'final');
  assert.equal(ctx.db.resolveAppId('newgame'), 'final');
  // The ORIGINAL old slug was repointed onto the latest canonical id.
  assert.equal(ctx.db.resolveAppId('oldgame'), 'final');
  // Display name was not passed, so it is preserved.
  assert.equal(ctx.db.getApp('final').name, 'New Game');
});

test('rename to the same id only updates the display name (no self-alias)', () => {
  ctx.addApp({ appId: 'samename', name: 'Before' });
  ctx.db.renameApp('samename', 'samename', 'After');
  assert.equal(ctx.db.getApp('samename').name, 'After');
  // No alias row for an id renamed onto itself: getAlias is internal, so probe
  // via resolveAppId - it must still resolve through the apps table only.
  assert.equal(ctx.db.resolveAppId('samename'), 'samename');
});
