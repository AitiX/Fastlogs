'use strict';

// Tests for the optional `sceneContext` and `correlationCode` ingest fields.
//
// Covers:
//   - round-trip: POST /api/logs with both -> 201, GET /api/logs/:id returns
//     sceneContext verbatim (opaque string) and correlationCode;
//   - absent fields surface as null (stable shape);
//   - correlationCode is trimmed and clamped to 64 chars;
//   - an oversize sceneContext is DROPPED (null), but the request still succeeds.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();

before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
});

after(() => ctx.close());

async function ingestAndGetMeta(overrides) {
  const ingestRes = await req(ctx.baseUrl, '/api/logs', {
    method: 'POST',
    body: makeIngestBody(overrides),
  });
  assert.equal(ingestRes.status, 201,
    `expected 201, got ${ingestRes.status}: ${JSON.stringify(ingestRes.body)}`);
  const { id } = ingestRes.body;

  const metaRes = await req(ctx.baseUrl, `/api/logs/${id}`);
  assert.equal(metaRes.status, 200,
    `meta expected 200, got ${metaRes.status}: ${JSON.stringify(metaRes.body)}`);
  return metaRes.body;
}

test('POST /api/logs round-trips sceneContext (verbatim string) and correlationCode', async () => {
  const sceneContext = JSON.stringify({
    truncated: false,
    stats: { scenes: 1, objects: 2, components: 3 },
    scenes: [{ name: 'Main', ddol: false, roots: [{ n: 'Root', a: true, tag: 'Untagged', layer: 0, comp: [], kids: [] }] }],
  });
  const meta = await ingestAndGetMeta({ sceneContext, correlationCode: 'ABC123' });

  assert.equal(meta.sceneContext, sceneContext, 'sceneContext must round-trip verbatim');
  assert.equal(meta.correlationCode, 'ABC123', 'correlationCode must round-trip');
});

test('POST /api/logs without sceneContext/correlationCode returns null fields', async () => {
  const meta = await ingestAndGetMeta({});
  assert.equal(meta.sceneContext, null, 'absent sceneContext must surface as null');
  assert.equal(meta.correlationCode, null, 'absent correlationCode must surface as null');
});

test('POST /api/logs trims and clamps correlationCode to 64 chars', async () => {
  const long = '  ' + 'c'.repeat(100) + '  ';
  const meta = await ingestAndGetMeta({ correlationCode: long });
  assert.equal(meta.correlationCode.length, 64, 'correlationCode clamped to 64 chars');
  assert.equal(meta.correlationCode, 'c'.repeat(64), 'trimmed then clamped');
});

test('POST /api/logs drops an oversize sceneContext but still succeeds', async () => {
  // > 1MB default MAX_SCENE_CONTEXT_BYTES: must be dropped (null), not a 4xx.
  const huge = 'x'.repeat(1024 * 1024 + 10);
  const meta = await ingestAndGetMeta({ sceneContext: huge });
  assert.equal(meta.sceneContext, null, 'oversize sceneContext is dropped to null');
});

test('POST /api/logs ignores a non-string sceneContext (no 400)', async () => {
  const meta = await ingestAndGetMeta({ sceneContext: { not: 'a string' } });
  assert.equal(meta.sceneContext, null, 'non-string sceneContext collapses to null');
});
