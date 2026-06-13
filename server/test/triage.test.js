'use strict';

// Triage status + tags, DEFAULT tier (open by link, no token required).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token';

let id;
before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
  const ing = await req(ctx.baseUrl, '/api/logs', { method: 'POST', body: makeIngestBody({}) });
  assert.equal(ing.status, 201);
  id = ing.body.id;
});
after(() => ctx.close());

test('fresh log defaults to status=new and tags=[]', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'new');
  assert.deepEqual(r.body.tags, []);
});

test('set status is open by link (no token needed) and persists', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/status', { method: 'POST', body: { status: 'triaged' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'triaged');
  const g = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(g.body.status, 'triaged');
});

test('set status also works with a viewer token in the header', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/status', {
    method: 'POST', body: { status: 'fixed' }, headers: { authorization: 'Bearer ' + VIEWER },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'fixed');
});

test('invalid status -> 400', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/status', { method: 'POST', body: { status: 'bogus' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_request');
});

test('set tags: dedupe (case-sensitive), drop empty, preserve order', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/tags', {
    method: 'POST', body: { tags: ['Crash', 'boss-fight', 'Crash', '', '  '] },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tags, ['Crash', 'boss-fight']);
  const g = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.deepEqual(g.body.tags, ['Crash', 'boss-fight']);
});

test('tags non-array -> 400', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/tags', { method: 'POST', body: { tags: 'crash' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'bad_request');
});

test('tag length capped at TRIAGE_TAG_MAX_LEN (32)', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/tags', { method: 'POST', body: { tags: ['x'.repeat(100)] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.tags[0].length, 32);
});

test('tag count capped at TRIAGE_TAG_MAX_COUNT (20)', async () => {
  const many = [];
  for (let i = 0; i < 50; i++) many.push('tag-' + i);
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/tags', { method: 'POST', body: { tags: many } });
  assert.equal(r.status, 200);
  assert.equal(r.body.tags.length, 20);
});

test('empty tags clears and round-trips to []', async () => {
  const r = await req(ctx.baseUrl, '/api/logs/' + id + '/tags', { method: 'POST', body: { tags: [] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.tags, []);
  const g = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.deepEqual(g.body.tags, []);
});

test('browse JSON exposes status + tags', async () => {
  await req(ctx.baseUrl, '/api/logs/' + id + '/status', { method: 'POST', body: { status: 'triaged' } });
  await req(ctx.baseUrl, '/api/logs/' + id + '/tags', { method: 'POST', body: { tags: ['regression'] } });
  const r = await req(ctx.baseUrl, '/browse/testapp/1.0.0?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  const log = r.body.logs.find((l) => l.id === id);
  assert.equal(log.status, 'triaged');
  assert.deepEqual(log.tags, ['regression']);
});

test('unknown id -> 404 for status and tags', async () => {
  const s = await req(ctx.baseUrl, '/api/logs/nope/status', { method: 'POST', body: { status: 'new' } });
  assert.equal(s.status, 404);
  const t = await req(ctx.baseUrl, '/api/logs/nope/tags', { method: 'POST', body: { tags: [] } });
  assert.equal(t.status, 404);
});
