'use strict';

// Tests for GET /api/await/:appId?code=XX&token=YY and db.getLatestByCode.
//
// Covers:
//   - auth: no token -> 401, viewer token -> 200, admin token -> 200;
//   - found by correlationCode -> { found:true, id, url, rawUrl, createdAt };
//   - found by comment fallback (code embedded in the free-text comment);
//   - not found -> { found:false, ... nulls };
//   - missing / too-long code -> 400;
//   - db.getLatestByCode returns the newest matching live row, or null.

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

let codeId, commentId;
before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
  codeId = await ingest({ correlationCode: 'WAIT-42' });
  commentId = await ingest({ comment: 'crash near boss, code=COMMENT-77 in arena' });
});

after(() => ctx.close());

test('await requires a viewer token (no token -> 401)', async () => {
  const r = await req(ctx.baseUrl, '/api/await/testapp?code=WAIT-42');
  assert.equal(r.status, 401);
});

test('await with a viewer token finds the log by correlationCode', async () => {
  const r = await req(ctx.baseUrl, '/api/await/testapp?code=WAIT-42&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.equal(r.body.found, true);
  assert.equal(r.body.id, codeId);
  assert.ok(r.body.url && r.body.url.indexOf(codeId) !== -1, 'url points at the found id');
  assert.ok(r.body.rawUrl && r.body.rawUrl.indexOf('/raw') !== -1, 'rawUrl ends in /raw');
  assert.ok(r.body.createdAt, 'createdAt present');
});

test('await also accepts an admin token', async () => {
  const r = await req(ctx.baseUrl, '/api/await/testapp?code=WAIT-42&token=' + ADMIN);
  assert.equal(r.status, 200);
  assert.equal(r.body.found, true);
});

test('await falls back to a code embedded in the comment', async () => {
  const r = await req(ctx.baseUrl, '/api/await/testapp?code=COMMENT-77&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.equal(r.body.found, true);
  assert.equal(r.body.id, commentId);
});

test('await returns found:false with null fields when nothing matches', async () => {
  const r = await req(ctx.baseUrl, '/api/await/testapp?code=NOPE-999&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { found: false, id: null, url: null, rawUrl: null, createdAt: null });
});

test('await without a code -> 400', async () => {
  const r = await req(ctx.baseUrl, '/api/await/testapp?token=' + VIEWER);
  assert.equal(r.status, 400);
});

test('await with an over-long code (>64) -> 400', async () => {
  const r = await req(ctx.baseUrl, '/api/await/testapp?code=' + 'x'.repeat(65) + '&token=' + VIEWER);
  assert.equal(r.status, 400);
});

test('db.getLatestByCode returns the newest matching live row, or null', async () => {
  const now = new Date().toISOString();
  const hit = ctx.db.getLatestByCode('testapp', 'WAIT-42', now);
  assert.ok(hit, 'expected a matching row');
  assert.equal(hit.id, codeId);
  assert.ok(hit.created_at, 'row carries created_at');

  const miss = ctx.db.getLatestByCode('testapp', 'NOPE-999', now);
  assert.equal(miss, null, 'no match -> null');
});
