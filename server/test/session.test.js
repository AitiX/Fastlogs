'use strict';

// Session grouping: optional ingest sessionId + GET /browse/:appId?session=...

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

let idA1, idA2, idB1, idNoSession;
before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'sess', name: 'Session App' });

  idA1 = await ingest({ appId: 'sess', appVersion: '1.0.0', sessionId: 'launch-A', title: 'A first' });
  idA2 = await ingest({ appId: 'sess', appVersion: '1.0.0', sessionId: 'launch-A', title: 'A second' });
  idB1 = await ingest({ appId: 'sess', appVersion: '1.0.0', sessionId: 'launch-B', title: 'B first' });
  idNoSession = await ingest({ appId: 'sess', appVersion: '1.0.0', title: 'no session' });
});
after(() => ctx.close());

test('publicLogObject exposes sessionId (set and null)', async () => {
  const withSession = await req(ctx.baseUrl, '/api/logs/' + idA1);
  assert.equal(withSession.status, 200);
  assert.equal(withSession.body.sessionId, 'launch-A');

  const without = await req(ctx.baseUrl, '/api/logs/' + idNoSession);
  assert.equal(without.status, 200);
  assert.equal(without.body.sessionId, null);
});

test('GET /browse/:appId?session= returns only that session, newest first', async () => {
  const r = await req(ctx.baseUrl, '/browse/sess?format=json&token=' + VIEWER + '&session=launch-A');
  assert.equal(r.status, 200);
  assert.equal(r.body.sessionId, 'launch-A');
  const ids = r.body.logs.map((x) => x.id);
  // Both A logs, the newest (A second) first; never B or the session-less log.
  assert.deepEqual(ids, [idA2, idA1]);
  for (const log of r.body.logs) assert.equal(log.sessionId, 'launch-A');
});

test('a different session is isolated', async () => {
  const r = await req(ctx.baseUrl, '/browse/sess?format=json&token=' + VIEWER + '&session=launch-B');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.logs.map((x) => x.id), [idB1]);
});

test('unknown session -> empty list (not an error)', async () => {
  const r = await req(ctx.baseUrl, '/browse/sess?format=json&token=' + VIEWER + '&session=nope');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.logs, []);
});

test('session view still requires the viewer token', async () => {
  const r = await req(ctx.baseUrl, '/browse/sess?format=json&session=launch-A');
  assert.equal(r.status, 401);
});

test('without ?session the endpoint still returns versions', async () => {
  const r = await req(ctx.baseUrl, '/browse/sess?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.versions), 'versions list when no session filter');
  assert.equal(r.body.sessionId, undefined);
});

test('catalog version rows carry sessionId for the UI session column', async () => {
  const r = await req(ctx.baseUrl, '/browse/sess/1.0.0?format=json&token=' + VIEWER);
  assert.equal(r.status, 200);
  const byId = new Map(r.body.logs.map((x) => [x.id, x]));
  assert.equal(byId.get(idA1).sessionId, 'launch-A');
  assert.equal(byId.get(idNoSession).sessionId, null);
});

test('blank/whitespace sessionId at ingest stores as null', async () => {
  const id = await ingest({ appId: 'sess', appVersion: '1.0.0', sessionId: '   ', title: 'blank session' });
  const r = await req(ctx.baseUrl, '/api/logs/' + id);
  assert.equal(r.body.sessionId, null);
});
