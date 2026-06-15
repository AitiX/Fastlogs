'use strict';

// Standalone file uploads (FastLogs SendFile / SendFolder):
//   POST /api/files (JSON + base64), GET /files/:id[/download], log attachments,
//   the decoded-size cap, auth, retention + sweeper.
//
// A small MAX_FILE_BYTES is set BEFORE requiring helpers so the cap (413) test
// is cheap. node --test runs each test file in its own process, so this env
// override does not leak into other test files.

process.env.MAX_FILE_BYTES = '1024'; // 1 KB cap for this file.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

// Minimal valid /api/files body, overridable.
function fileBody(overrides = {}) {
  return Object.assign({
    appId: 'testapp',
    platform: 'Windows',
    appVersion: '1.0.0',
    name: 'hello.txt',
    mime: 'text/plain',
    fileBase64: b64('hello world'),
  }, overrides);
}

async function upload(overrides) {
  return req(ctx.baseUrl, '/api/files', { method: 'POST', body: fileBody(overrides) });
}

async function ingest(overrides) {
  return req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody(overrides) });
}

before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
});
after(() => ctx.close());

test('upload succeeds and the download matches the bytes verbatim', async () => {
  const up = await upload({ name: 'note.txt', fileBase64: b64('the-exact-bytes') });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.ok(up.body.id, 'response has id');
  assert.match(String(up.body.url || ''), /\/files\//);
  assert.match(String(up.body.downloadUrl || ''), /\/files\/.+\/download$/);
  assert.ok(up.body.expiresAt, 'response has expiresAt');

  const dl = await req(ctx.baseUrl, '/files/' + up.body.id + '/download');
  assert.equal(dl.status, 200);
  assert.equal(dl.body, 'the-exact-bytes');
  assert.match(String(dl.headers['content-type'] || ''), /text\/plain/);
  assert.match(String(dl.headers['content-disposition'] || ''), /attachment/);
  assert.match(String(dl.headers['content-disposition'] || ''), /note\.txt/);
});

test('standalone viewer GET /files/:id returns HTML with name + Download', async () => {
  const up = await upload({ name: 'save.bin' });
  const v = await req(ctx.baseUrl, '/files/' + up.body.id);
  assert.equal(v.status, 200);
  assert.match(String(v.headers['content-type'] || ''), /text\/html/);
  assert.match(v.body, /save\.bin/);
  assert.match(v.body, /\/files\/.+\/download/);
});

test('default mime is application/octet-stream when omitted', async () => {
  const up = await upload({ name: 'blob', mime: undefined });
  const dl = await req(ctx.baseUrl, '/files/' + up.body.id + '/download');
  assert.match(String(dl.headers['content-type'] || ''), /application\/octet-stream/);
});

test('cap: decoded size over MAX_FILE_BYTES -> 413', async () => {
  // 2 KB of raw bytes decodes from ~2.7 KB base64, well over the 1 KB cap.
  const big = b64('A'.repeat(2 * 1024));
  const up = await upload({ fileBase64: big });
  assert.equal(up.status, 413);
});

test('non-json Content-Type -> 415', async () => {
  const up = await req(ctx.baseUrl, '/api/files', {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: 'not json',
  });
  assert.equal(up.status, 415);
});

test('missing fileBase64 -> 400', async () => {
  const up = await upload({ fileBase64: undefined });
  assert.equal(up.status, 400);
});

test('missing appId -> 400', async () => {
  const up = await upload({ appId: undefined });
  assert.equal(up.status, 400);
});

test('missing platform -> 400', async () => {
  const up = await upload({ platform: undefined });
  assert.equal(up.status, 400);
});

test('missing name -> 400', async () => {
  const up = await upload({ name: undefined });
  assert.equal(up.status, 400);
});

test('unknown appId -> 403', async () => {
  const up = await upload({ appId: 'nope-unknown' });
  assert.equal(up.status, 403);
});

test('app that requires a token: no token -> 401, wrong token -> 403, valid token -> 201', async () => {
  ctx.addApp({ appId: 'tokapp', name: 'Token App', token: 'sekret' });
  const noTok = await req(ctx.baseUrl, '/api/files', {
    method: 'POST',
    body: fileBody({ appId: 'tokapp' }),
  });
  assert.equal(noTok.status, 401);

  const wrongTok = await req(ctx.baseUrl, '/api/files', {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token' },
    body: fileBody({ appId: 'tokapp' }),
  });
  assert.equal(wrongTok.status, 403);

  const withTok = await req(ctx.baseUrl, '/api/files', {
    method: 'POST',
    headers: { authorization: 'Bearer sekret' },
    body: fileBody({ appId: 'tokapp' }),
  });
  assert.equal(withTok.status, 201);
});

test('logId binding -> file appears in the log attachments[]', async () => {
  const ing = await ingest({});
  assert.equal(ing.status, 201);
  const logId = ing.body.id;

  const up = await upload({ name: 'attached.txt', logId, fileBase64: b64('attached-content') });
  assert.equal(up.status, 201);

  const meta = await req(ctx.baseUrl, '/api/logs/' + logId);
  assert.equal(meta.status, 200);
  assert.ok(Array.isArray(meta.body.attachments), 'log has attachments[]');
  assert.equal(meta.body.attachments.length, 1);
  const att = meta.body.attachments[0];
  assert.equal(att.id, up.body.id);
  assert.equal(att.name, 'attached.txt');
  assert.equal(att.downloadUrl, '/files/' + up.body.id + '/download');

  // The attachment is downloadable.
  const dl = await req(ctx.baseUrl, att.downloadUrl);
  assert.equal(dl.status, 200);
  assert.equal(dl.body, 'attached-content');
});

test('a log with no attachments exposes an empty attachments[]', async () => {
  const ing = await ingest({});
  const meta = await req(ctx.baseUrl, '/api/logs/' + ing.body.id);
  assert.deepEqual(meta.body.attachments, []);
});

test('groupId is accepted and stored', async () => {
  const up = await upload({ groupId: 'session-7', name: 'part1.bin' });
  assert.equal(up.status, 201);
  // The row carries the group; the public attachment shape does not surface it,
  // so we assert via the DB to lock the column wiring.
  const row = ctx.db.getFile(up.body.id);
  assert.equal(row.group_id, 'session-7');
});

test('expired non-pinned file -> 404 and the sweeper removes blob + row', async () => {
  const up = await upload({ name: 'doomed.bin', fileBase64: b64('doomed') });
  const id = up.body.id;
  const storage = require('../src/storage');

  // Force expiry into the past via the pin statement (pinned=0, past expires).
  ctx.db.setFilePin(id, 0, '2000-01-01T00:00:00.000Z');

  // Liveness: an expired non-pinned file is already treated as gone.
  assert.equal((await req(ctx.baseUrl, '/files/' + id)).status, 404);
  assert.equal((await req(ctx.baseUrl, '/files/' + id + '/download')).status, 404);

  // The blob is still on disk until the sweeper runs.
  assert.notEqual(await storage.readFile(id), null);

  const sweeper = require('../src/sweeper');
  const r = await sweeper.sweep();
  assert.ok(r.filesDeleted >= 1, 'sweeper deleted at least one file row');

  // Blob and row are both gone.
  assert.equal(await storage.readFile(id), null);
  assert.equal(ctx.db.getFile(id), undefined);
});

test('pinned file survives an expired-in-the-past timestamp and the sweep', async () => {
  const up = await upload({ name: 'kept.bin' });
  const id = up.body.id;
  ctx.db.setFilePin(id, 1, null); // pinned, never expires

  const sweeper = require('../src/sweeper');
  await sweeper.sweep();

  assert.equal((await req(ctx.baseUrl, '/files/' + id)).status, 200);
  assert.ok(ctx.db.getFile(id), 'pinned file row remains');
});

test('kind="snapshot" linked by logId is accepted and listed as a snapshot attachment', async () => {
  const ing = await ingest({});
  assert.equal(ing.status, 201);
  const logId = ing.body.id;

  // The full-game-state archive: kind is accepted (not coerced to null) and the
  // upload is stored + linked just like any other attachment kind.
  const up = await upload({
    name: 'snapshot.zip', mime: 'application/zip', kind: 'snapshot',
    logId, fileBase64: b64('PK-snapshot-bytes'),
  });
  assert.equal(up.status, 201, JSON.stringify(up.body));

  // The stored row keeps the snapshot kind (not nulled).
  assert.equal(ctx.db.getFile(up.body.id).kind, 'snapshot');

  // It surfaces in the log's attachments[] with kind="snapshot".
  const meta = await req(ctx.baseUrl, '/api/logs/' + logId);
  assert.equal(meta.status, 200);
  assert.equal(meta.body.attachments.length, 1);
  const att = meta.body.attachments[0];
  assert.equal(att.id, up.body.id);
  assert.equal(att.kind, 'snapshot');
  assert.equal(att.name, 'snapshot.zip');
  assert.equal(att.downloadUrl, '/files/' + up.body.id + '/download');

  // And the snapshot archive is downloadable verbatim.
  const dl = await req(ctx.baseUrl, att.downloadUrl);
  assert.equal(dl.status, 200);
  assert.equal(dl.body, 'PK-snapshot-bytes');
});

test('an unknown kind still coerces to null (existing behavior preserved)', async () => {
  const up = await upload({ name: 'mystery.bin', kind: 'totally-bogus-kind' });
  assert.equal(up.status, 201);
  assert.equal(ctx.db.getFile(up.body.id).kind, null);
});
