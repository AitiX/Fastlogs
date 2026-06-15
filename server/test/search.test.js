'use strict';

// Full-text search over the catalog: GET /api/search (FTS5).

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

function searchUrl(appId, q, extra) {
  let u = '/api/search?token=' + VIEWER + '&appId=' + encodeURIComponent(appId) + '&q=' + encodeURIComponent(q);
  if (extra) u += extra;
  return u;
}

let idCrash, idSave, idOther;
before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'srch', name: 'Search App' });
  ctx.addApp({ appId: 'other', name: 'Other App' });

  idCrash = await ingest({
    appId: 'srch', appVersion: '1.0.0',
    title: 'Crash on level load', comment: 'froze on loading level three', tester: 'Alex',
    context: { level: '3', playerId: 'zephyr' },
    logText: 'NullReferenceException at PlayerController.Update wibblewobble',
  });
  idSave = await ingest({
    appId: 'srch', appVersion: '1.1.0',
    title: 'Save corruption', tester: 'Bob',
    logText: 'IOException reading save slot quokkamarble',
  });
  // A log in another app that should never leak into srch results.
  idOther = await ingest({
    appId: 'other', appVersion: '1.0.0',
    title: 'Wibblewobble in other app',
    logText: 'wibblewobble appears here too',
  });
});
after(() => ctx.close());

test('search by title term', async () => {
  const r = await req(ctx.baseUrl, searchUrl('srch', 'crash'));
  assert.equal(r.status, 200);
  const ids = r.body.results.map((x) => x.id);
  assert.deepEqual(ids, [idCrash]);
  // Catalog row shape is present.
  assert.equal(r.body.results[0].title, 'Crash on level load');
  assert.ok('counts' in r.body.results[0]);
});

test('search by log body term', async () => {
  const r = await req(ctx.baseUrl, searchUrl('srch', 'wibblewobble'));
  assert.equal(r.status, 200);
  const ids = r.body.results.map((x) => x.id);
  assert.deepEqual(ids, [idCrash], 'body match in srch only, never the other app');
});

test('search by context value', async () => {
  const r = await req(ctx.baseUrl, searchUrl('srch', 'zephyr'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.id), [idCrash]);
});

test('search by tester name', async () => {
  const r = await req(ctx.baseUrl, searchUrl('srch', 'Bob'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.id), [idSave]);
});

test('prefix search with trailing *', async () => {
  const r = await req(ctx.baseUrl, searchUrl('srch', 'quokka*'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.id), [idSave]);
});

test('two terms are AND-ed', async () => {
  const r = await req(ctx.baseUrl, searchUrl('srch', 'loading three'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.id), [idCrash]);
  const none = await req(ctx.baseUrl, searchUrl('srch', 'loading quokkamarble'));
  assert.equal(none.body.count, 0, 'terms from different logs AND to nothing');
});

test('no match -> empty results', async () => {
  const r = await req(ctx.baseUrl, searchUrl('srch', 'hippopotamus'));
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 0);
  assert.deepEqual(r.body.results, []);
});

test('version filter narrows results', async () => {
  // "save" matches idSave (1.1.0); filtering to 1.0.0 drops it.
  const all = await req(ctx.baseUrl, searchUrl('srch', 'save'));
  assert.deepEqual(all.body.results.map((x) => x.id), [idSave]);
  const filtered = await req(ctx.baseUrl, searchUrl('srch', 'save', '&version=1.0.0'));
  assert.equal(filtered.body.count, 0);
  const kept = await req(ctx.baseUrl, searchUrl('srch', 'save', '&version=1.1.0'));
  assert.deepEqual(kept.body.results.map((x) => x.id), [idSave]);
});

test('results carry a snippet from the body', async () => {
  const r = await req(ctx.baseUrl, searchUrl('srch', 'NullReferenceException'));
  assert.equal(r.status, 200);
  assert.equal(r.body.results.length, 1);
  assert.ok(typeof r.body.results[0].snippet === 'string');
  assert.ok(r.body.results[0].snippet.indexOf('NullReferenceException') !== -1);
});

test('a malicious MATCH-injection query is neutralized (no 500)', async () => {
  // FTS5 column-filter / NEAR / unbalanced quote attempts must not error.
  for (const q of ['title:crash', 'NEAR(a b)', 'crash"', '"', '* OR *', 'AND OR NOT']) {
    const r = await req(ctx.baseUrl, searchUrl('srch', q));
    assert.equal(r.status, 200, `query ${JSON.stringify(q)} should not 500: ${r.status}`);
    assert.ok(Array.isArray(r.body.results));
  }
});

test('admin token also authorizes search', async () => {
  const r = await req(ctx.baseUrl, '/api/search?token=' + ADMIN + '&appId=srch&q=crash');
  assert.equal(r.status, 200);
});

test('missing token -> 401', async () => {
  const r = await req(ctx.baseUrl, '/api/search?appId=srch&q=crash');
  assert.equal(r.status, 401);
});

test('missing appId -> 400', async () => {
  const r = await req(ctx.baseUrl, '/api/search?token=' + VIEWER + '&q=crash');
  assert.equal(r.status, 400);
});

test('unknown appId -> 404', async () => {
  const r = await req(ctx.baseUrl, searchUrl('nope', 'crash'));
  assert.equal(r.status, 404);
});

test('empty query -> 200 with zero results (no error)', async () => {
  const r = await req(ctx.baseUrl, searchUrl('srch', '   '));
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 0);
});

test('lazy backfill indexes a pre-feature log on first query', async () => {
  // Simulate a log stored before the FTS feature: ingest normally (body on
  // disk), then drop its FTS row and reset fts_indexed so it looks un-indexed.
  const id = await ingest({
    appId: 'srch', appVersion: '2.0.0',
    title: 'Pre-feature entry', logText: 'antediluvianlog marker text',
  });

  // Confirm it is searchable now (ingest indexed it).
  let r = await req(ctx.baseUrl, searchUrl('srch', 'antediluvianlog'));
  assert.deepEqual(r.body.results.map((x) => x.id), [id]);

  // Reset the whole index to "empty + not indexed", mimicking a DB whose logs
  // predate the FTS feature: clear the FTS table and the fts_indexed flag.
  const raw = ctx.db.db;
  raw.prepare('DELETE FROM logs_fts').run();
  raw.prepare('UPDATE logs SET fts_indexed = 0').run();

  // First query after the reset must find it again (lazy backfill re-indexed
  // a bounded batch of the not-yet-indexed logs, including this one).
  r = await req(ctx.baseUrl, searchUrl('srch', 'antediluvianlog'));
  assert.deepEqual(r.body.results.map((x) => x.id), [id], 'lazy backfill re-indexed the pre-feature log');
});
