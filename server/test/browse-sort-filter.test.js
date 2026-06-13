'use strict';

// Contract for the catalog client's sort / errors-only / status controls
// (public/browse.js). Those controls are purely client-side, but they depend on
// fields the server must supply in GET /browse/:appId/:version JSON:
//   - counts.error  (number)  -> errors-only filter + "most errors" sort
//   - logBytes      (number)  -> "largest" sort
//   - time / createdAt        -> newest/oldest sort
// and on the default order being newest-first (created_at DESC). This test pins
// those guarantees so the UI does not silently break if the route changes.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();
const VIEWER = 'viewer-test-token'; // matches helpers.setup()

const APP = 'sortapp';
const VER = '2.0.0';

before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: APP, name: 'Sort App' });

  // Three logs for one app/version with distinct error counts and clearly
  // distinct sizes (short / medium / long log text). Ingested sequentially so
  // their created_at timestamps are monotonically increasing.
  const ingests = [
    { counts: { error: 0, warn: 1, log: 2 }, logText: 'a' },
    { counts: { error: 2, warn: 0, log: 1 }, logText: 'b'.repeat(200) },
    { counts: { error: 5, warn: 3, log: 4 }, logText: 'c'.repeat(2000) },
  ];

  for (const o of ingests) {
    const ing = await req(ctx.baseUrl, '/api/logs', {
      method: 'POST',
      body: makeIngestBody({ appId: APP, appVersion: VER, counts: o.counts, logText: o.logText }),
    });
    assert.equal(ing.status, 201, `ingest failed: ${ing.status} ${JSON.stringify(ing.body)}`);
  }
});

after(() => ctx.close());

test('browse logs JSON carries the fields the client sort/errors-only depend on', async () => {
  const r = await req(ctx.baseUrl, `/browse/${APP}/${VER}?format=json&token=` + VIEWER, {
    headers: { accept: 'application/json' },
  });
  assert.equal(r.status, 200, `browse failed: ${r.status} ${JSON.stringify(r.body)}`);
  assert.ok(Array.isArray(r.body.logs), 'logs must be an array');
  assert.equal(r.body.logs.length, 3, 'expected exactly the three ingested logs');

  for (const log of r.body.logs) {
    // counts.error drives errors-only filter and the "most errors" sort.
    assert.ok(log.counts && typeof log.counts.error === 'number',
      'each log must expose counts.error as a number');
    // logBytes drives the "largest" sort.
    assert.equal(typeof log.logBytes, 'number', 'logBytes must be a number');
    assert.ok(log.logBytes >= 0, 'logBytes must be >= 0');
    // A timestamp (time or createdAt) drives the newest/oldest sort.
    const ts = log.time || log.createdAt;
    assert.ok(typeof ts === 'string' && !Number.isNaN(Date.parse(ts)),
      'each log must expose a parseable time or createdAt');
  }
});

test('browse logs default order is newest-first (created_at DESC)', async () => {
  const r = await req(ctx.baseUrl, `/browse/${APP}/${VER}?format=json&token=` + VIEWER, {
    headers: { accept: 'application/json' },
  });
  assert.equal(r.status, 200, `browse failed: ${r.status} ${JSON.stringify(r.body)}`);
  const logs = r.body.logs;
  assert.equal(logs.length, 3, 'expected exactly the three ingested logs');

  // created_at must be non-increasing across the array (newest first). This is
  // the default order the client assumes before any "sort" control is touched.
  for (let i = 1; i < logs.length; i++) {
    const prev = Date.parse(logs[i - 1].createdAt);
    const cur = Date.parse(logs[i].createdAt);
    assert.ok(prev >= cur,
      `logs must be newest-first by createdAt: index ${i - 1} (${logs[i - 1].createdAt}) >= index ${i} (${logs[i].createdAt})`);
  }
});
