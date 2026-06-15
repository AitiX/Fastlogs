'use strict';

// Log folders: GET /api/folders + POST /api/folders/move (viewer-token gated).
// Covers move/list, the catalog ?folder= filter, per-app isolation, the root
// (folder=null), folder-path validation, and alias resolution of the appId.

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

function move(body, token) {
  const t = token === undefined ? VIEWER : token;
  const url = '/api/folders/move' + (t ? '?token=' + t : '');
  return req(ctx.baseUrl, url, { method: 'POST', body });
}

let idA, idB, idC, idOther;
before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'fld', name: 'Folder App' });
  ctx.addApp({ appId: 'other', name: 'Other App' });

  idA = await ingest({ appId: 'fld', appVersion: '1.0.0', title: 'log A' });
  idB = await ingest({ appId: 'fld', appVersion: '1.0.0', title: 'log B' });
  idC = await ingest({ appId: 'fld', appVersion: '1.0.0', title: 'log C' });
  idOther = await ingest({ appId: 'other', appVersion: '1.0.0', title: 'other log' });
});
after(() => ctx.close());

test('logs start in the root (folder null) and folders list is empty', async () => {
  const meta = await req(ctx.baseUrl, '/api/logs/' + idA);
  assert.equal(meta.body.folder, null);
  const f = await req(ctx.baseUrl, '/api/folders?token=' + VIEWER + '&appId=fld');
  assert.equal(f.status, 200);
  assert.deepEqual(f.body.folders, []);
});

test('move assigns a folder and the folder appears in the list', async () => {
  const r = await move({ appId: 'fld', ids: [idA, idB], folder: 'Release/QA' });
  assert.equal(r.status, 200);
  assert.equal(r.body.folder, 'Release/QA');
  assert.equal(r.body.moved, 2);

  const f = await req(ctx.baseUrl, '/api/folders?token=' + VIEWER + '&appId=fld');
  assert.deepEqual(f.body.folders, ['Release/QA']);

  const meta = await req(ctx.baseUrl, '/api/logs/' + idA);
  assert.equal(meta.body.folder, 'Release/QA');
});

test('catalog version rows carry the folder field', async () => {
  const r = await req(ctx.baseUrl, '/browse/fld/1.0.0?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  const byId = new Map(r.body.logs.map((x) => [x.id, x]));
  assert.equal(byId.get(idA).folder, 'Release/QA');
  assert.equal(byId.get(idC).folder, null);
});

test('?folder= filters the version listing to that exact folder', async () => {
  const inFolder = await req(ctx.baseUrl, '/browse/fld/1.0.0?format=json&token=' + VIEWER + '&folder=' + encodeURIComponent('Release/QA'));
  assert.equal(inFolder.status, 200);
  assert.deepEqual(inFolder.body.logs.map((x) => x.id).sort(), [idA, idB].sort());
});

test('?folder= empty selects the ROOT (folder null) only', async () => {
  const root = await req(ctx.baseUrl, '/browse/fld/1.0.0?format=json&token=' + VIEWER + '&folder=');
  assert.equal(root.status, 200);
  // Only idC is still in the root (idA, idB were moved to Release/QA).
  assert.deepEqual(root.body.logs.map((x) => x.id), [idC]);
});

test('move with empty folder sends a log back to the root', async () => {
  const r = await move({ appId: 'fld', ids: [idA], folder: '' });
  assert.equal(r.status, 200);
  assert.equal(r.body.folder, null);
  assert.equal(r.body.moved, 1);
  const meta = await req(ctx.baseUrl, '/api/logs/' + idA);
  assert.equal(meta.body.folder, null);
});

test('moves are isolated per app: a cross-app id is skipped', async () => {
  // idOther belongs to "other"; moving it under appId fld must not change it.
  const r = await move({ appId: 'fld', ids: [idC, idOther], folder: 'Bugs' });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, 1, 'only the fld-owned id moved');
  const otherMeta = await req(ctx.baseUrl, '/api/logs/' + idOther);
  assert.equal(otherMeta.body.folder, null, 'cross-app log untouched');
});

test('folders are isolated per app in the listing', async () => {
  const f = await req(ctx.baseUrl, '/api/folders?token=' + VIEWER + '&appId=other');
  assert.deepEqual(f.body.folders, [], 'other app has no folders');
});

test('unknown / cross-app ids do not error, just do not count', async () => {
  const r = await move({ appId: 'fld', ids: ['zzzzzz', idOther], folder: 'Nowhere' });
  assert.equal(r.status, 200);
  assert.equal(r.body.moved, 0);
});

test('folder path is normalized (slashes collapsed, segments trimmed)', async () => {
  const r = await move({ appId: 'fld', ids: [idB], folder: '  Builds //  Nightly / ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.folder, 'Builds/Nightly');
});

test('traversal / control chars / bad types are rejected with 400', async () => {
  for (const bad of ['a/../b', './x', 'a/b\nc', 'a/b\tc']) {
    const r = await move({ appId: 'fld', ids: [idB], folder: bad });
    assert.equal(r.status, 400, `folder ${JSON.stringify(bad)} should be rejected`);
  }
  // Non-string folder.
  const num = await move({ appId: 'fld', ids: [idB], folder: 5 });
  assert.equal(num.status, 400);
});

test('over-deep and over-long folders are rejected', async () => {
  const tooDeep = Array.from({ length: 20 }, (_, i) => 's' + i).join('/');
  const deep = await move({ appId: 'fld', ids: [idB], folder: tooDeep });
  assert.equal(deep.status, 400);
  const tooLongSeg = 'x'.repeat(200);
  const longSeg = await move({ appId: 'fld', ids: [idB], folder: tooLongSeg });
  assert.equal(longSeg.status, 400);
});

test('move requires the viewer token', async () => {
  const r = await move({ appId: 'fld', ids: [idA], folder: 'X' }, '');
  assert.equal(r.status, 401);
  const list = await req(ctx.baseUrl, '/api/folders?appId=fld');
  assert.equal(list.status, 401);
});

test('move with no ids -> 400', async () => {
  const r = await move({ appId: 'fld', ids: [], folder: 'X' });
  assert.equal(r.status, 400);
});

test('unknown appId -> 404 on both endpoints', async () => {
  const r = await move({ appId: 'nope', ids: [idA], folder: 'X' });
  assert.equal(r.status, 404);
  const list = await req(ctx.baseUrl, '/api/folders?token=' + VIEWER + '&appId=nope');
  assert.equal(list.status, 404);
});

test('appId alias resolves for folders endpoints', async () => {
  // Rename fld -> fld2; the OLD slug must still work for list + move.
  ctx.db.renameApp('fld', 'fld2', null);
  const list = await req(ctx.baseUrl, '/api/folders?token=' + VIEWER + '&appId=fld');
  assert.equal(list.status, 200);
  assert.equal(list.body.appId, 'fld2', 'resolved to canonical id');

  const r = await move({ appId: 'fld', ids: [idC], folder: 'ViaAlias' });
  assert.equal(r.status, 200);
  assert.equal(r.body.appId, 'fld2');
  assert.equal(r.body.moved, 1);
  const meta = await req(ctx.baseUrl, '/api/logs/' + idC);
  assert.equal(meta.body.folder, 'ViaAlias');
});
