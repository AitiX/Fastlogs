'use strict';

// Project rename + alias: an OLD appId keeps working for ingest, browse,
// search, file uploads and await after a rename, and nothing is lost (logs are
// re-keyed, ids/links unchanged). Exercises db.renameApp / db.resolveAppId
// through the HTTP surface.
//
// The shared team token + auto-register are enabled here (env set BEFORE
// requiring helpers, which loads config once) so the file-upload case can prove
// that an old-slug upload routed through the team token does NOT re-create a
// live app under the old slug and SHADOW the alias.

process.env.TEAM_INGEST_TOKEN = 'team-secret-token';
process.env.ALLOW_AUTO_REGISTER = '1';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';
const TEAM_TOKEN = 'team-secret-token';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

async function ingest(overrides) {
  const r = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody(overrides) });
  assert.equal(r.status, 201, `ingest failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

// POST /api/files with a minimal valid body, overridable; returns the response.
async function uploadFile(overrides = {}, headers) {
  const body = Object.assign({
    appId: 'testapp',
    platform: 'Windows',
    appVersion: '1.0.0',
    name: 'save.bin',
    mime: 'application/octet-stream',
    fileBase64: b64('file-bytes'),
  }, overrides);
  return req(ctx.baseUrl, '/api/files', { method: 'POST', body, headers });
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

test('file upload under the OLD appId stores under the NEW canonical id', async () => {
  // Per-app token tier: the old slug 'oldgame' is now an alias of 'newgame',
  // which is tokenless, so an unauthenticated upload under the old slug must
  // succeed and the stored row must carry the canonical id.
  const up = await uploadFile({ appId: 'oldgame', name: 'old-slug.bin' });
  assert.equal(up.status, 201, `upload failed: ${up.status} ${JSON.stringify(up.body)}`);
  const row = ctx.db.getFile(up.body.id);
  assert.equal(row.app_id, 'newgame', 'old-slug upload stored under the canonical id');
});

test('team-token file upload under the OLD slug does NOT re-create/shadow the alias', async () => {
  // With the team token + auto-register on, an upload under the old slug would
  // (before the fix) auto-create a LIVE app 'oldgame', which resolveAppId
  // checks before aliases - silently undoing the rename. Threading the canonical
  // id through auto-register prevents that: no 'oldgame' app row appears, the
  // alias still resolves to 'newgame', and the file lands under 'newgame'.
  assert.equal(ctx.db.getApp('oldgame'), undefined, 'old slug must not be a live app pre-upload');

  const up = await uploadFile(
    { appId: 'oldgame', name: 'team-old-slug.bin' },
    { authorization: `Bearer ${TEAM_TOKEN}` },
  );
  assert.equal(up.status, 201, `upload failed: ${up.status} ${JSON.stringify(up.body)}`);

  assert.equal(ctx.db.getApp('oldgame'), undefined, 'old slug must NOT be re-created as a live app');
  assert.equal(ctx.db.resolveAppId('oldgame'), 'newgame', 'alias still resolves to the canonical id');
  const row = ctx.db.getFile(up.body.id);
  assert.equal(row.app_id, 'newgame', 'team-token old-slug upload stored under the canonical id');
});

test('await under the OLD appId finds a log ingested via the alias', async () => {
  // Ingest a log under the OLD slug carrying a correlation code; it is re-keyed
  // to 'newgame'. An await poll under the OLD slug must still resolve through
  // the alias and find it (without the fix it would be found:false forever).
  await ingest({ appId: 'oldgame', appVersion: '1.2.0', correlationCode: 'RENAME-AWAIT-1' });

  const r = await req(ctx.baseUrl, '/api/await/oldgame?code=RENAME-AWAIT-1&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.equal(r.body.found, true, 'await under the old slug finds the alias-routed log');
  assert.ok(r.body.id, 'await returns the found log id');
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
