'use strict';

// Tests for the optional `context` and `breadcrumbs` ingest fields.
//
// Covers:
//   - round-trip: POST /api/logs with context+breadcrumbs -> 201, then
//     GET /api/logs/:id returns them as { object } and [ array ];
//   - missing context/breadcrumbs surface as {} and [] (stable shape);
//   - invalid types (context as array, breadcrumbs as object) are ignored
//     (not 400) and surface as the empty defaults;
//   - oversize input is clamped server-side: breadcrumbs to <=100 items,
//     context entries dropped once the ~4KB budget is exceeded, per-field
//     key/value/text truncation, and lvl restricted to the enum.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { setup, makeIngestBody, req } = require('./helpers');

const ctx = setup();

before(async () => {
  await ctx.ready;
  ctx.addApp({ appId: 'testapp', name: 'Test App' });
});

after(() => ctx.close());

// Ingest a body, assert 201, fetch its meta, and return the meta body.
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

// -------------------------------------------------------------------------
// 1. Round-trip: context + breadcrumbs are stored and returned.
// -------------------------------------------------------------------------
test('POST /api/logs with context and breadcrumbs round-trips via GET /api/logs/:id', async () => {
  const context = { level: '3', playerId: 'abc' };
  const breadcrumbs = [
    { t: '2026-06-12T09:29:58Z', m: 'opened shop', lvl: 'info' },
    { t: '2026-06-12T09:30:00Z', m: 'bought item', lvl: 'warn' },
  ];

  const meta = await ingestAndGetMeta({ context, breadcrumbs });

  assert.deepEqual(meta.context, context, 'context must round-trip as an object');
  assert.ok(Array.isArray(meta.breadcrumbs), 'breadcrumbs must be an array');
  assert.equal(meta.breadcrumbs.length, 2, 'both breadcrumbs must be present');
  assert.deepEqual(meta.breadcrumbs[0], breadcrumbs[0], 'first breadcrumb verbatim');
  assert.deepEqual(meta.breadcrumbs[1], breadcrumbs[1], 'second breadcrumb verbatim');
});

// -------------------------------------------------------------------------
// 2. Missing context/breadcrumbs -> stable empty defaults ({} and []).
// -------------------------------------------------------------------------
test('POST /api/logs without context/breadcrumbs returns 201 and empty defaults', async () => {
  const meta = await ingestAndGetMeta({});
  assert.deepEqual(meta.context, {}, 'absent context must surface as {}');
  assert.deepEqual(meta.breadcrumbs, [], 'absent breadcrumbs must surface as []');
});

// -------------------------------------------------------------------------
// 3. Invalid types are ignored, not rejected (fields are optional).
// -------------------------------------------------------------------------
test('POST /api/logs ignores invalid context/breadcrumbs types (no 400)', async () => {
  // context as array and breadcrumbs as object are the wrong shapes; the
  // server must coerce them to the empty defaults rather than returning 400.
  const meta = await ingestAndGetMeta({ context: [1, 2, 3], breadcrumbs: { not: 'an array' } });
  assert.deepEqual(meta.context, {}, 'array context must collapse to {}');
  assert.deepEqual(meta.breadcrumbs, [], 'object breadcrumbs must collapse to []');
});

// -------------------------------------------------------------------------
// 4. Breadcrumbs overflow -> clamped to <=100 items.
// -------------------------------------------------------------------------
test('POST /api/logs clamps breadcrumbs to at most 100 items', async () => {
  const many = [];
  for (let i = 0; i < 250; i++) many.push({ m: 'event ' + i, lvl: 'info' });

  const meta = await ingestAndGetMeta({ breadcrumbs: many });
  assert.ok(Array.isArray(meta.breadcrumbs), 'breadcrumbs must be an array');
  assert.ok(meta.breadcrumbs.length <= 100,
    `breadcrumbs must be clamped to <=100, got ${meta.breadcrumbs.length}`);
  assert.equal(meta.breadcrumbs.length, 100, 'exactly 100 kept (item cap, under byte cap)');
  // Order preserved from the start of the array.
  assert.equal(meta.breadcrumbs[0].m, 'event 0', 'first kept breadcrumb is the first sent');
});

// -------------------------------------------------------------------------
// 5. Context overflow -> entries dropped once the ~4KB budget is exceeded,
//    and per-field key/value lengths are truncated.
// -------------------------------------------------------------------------
test('POST /api/logs clamps oversize context (byte budget + key/value truncation)', async () => {
  const context = {};
  // 100 entries of ~600 bytes each (key ~ short, value 600) far exceeds 4KB.
  for (let i = 0; i < 100; i++) {
    context['k' + i] = 'v'.repeat(600); // value > 512 cap, will be truncated
  }
  // Add one deliberately overlong key (> 64 chars).
  const longKey = 'K'.repeat(200);
  context[longKey] = 'x';

  const meta = await ingestAndGetMeta({ context });

  assert.equal(typeof meta.context, 'object', 'context must be an object');
  assert.ok(!Array.isArray(meta.context), 'context must not be an array');

  const keys = Object.keys(meta.context);
  // Far fewer than 101 entries survive the 4KB budget.
  assert.ok(keys.length < 101, `context must be clamped under budget, got ${keys.length} keys`);
  assert.ok(keys.length >= 1, 'at least one context entry should survive');

  // Total serialized size of values+keys must respect the ~4KB cap.
  let total = 0;
  for (const k of keys) {
    assert.ok(Buffer.byteLength(k, 'utf8') <= 64, `key "${k}" must be <=64 bytes`);
    const v = meta.context[k];
    assert.ok(Buffer.byteLength(v, 'utf8') <= 512, 'each value must be <=512 bytes');
    total += Buffer.byteLength(k, 'utf8') + Buffer.byteLength(v, 'utf8');
  }
  assert.ok(total <= 4 * 1024, `summed context bytes must be <=4KB, got ${total}`);
});

// -------------------------------------------------------------------------
// 6. Breadcrumb field hygiene: text truncated, bad lvl dropped, no-m skipped.
// -------------------------------------------------------------------------
test('POST /api/logs sanitizes breadcrumb fields (truncate m, drop bad lvl, skip empty)', async () => {
  const breadcrumbs = [
    { m: 'a'.repeat(1000), lvl: 'bogus' }, // m truncated to 512, lvl dropped
    { m: 'ok', lvl: 'error' },             // valid lvl kept
    { lvl: 'info' },                       // no m -> skipped entirely
    { m: '' },                             // empty m -> skipped entirely
  ];

  const meta = await ingestAndGetMeta({ breadcrumbs });
  assert.equal(meta.breadcrumbs.length, 2, 'only the two breadcrumbs with usable m survive');

  const first = meta.breadcrumbs[0];
  assert.equal(first.m.length, 512, 'overlong m truncated to 512 chars');
  assert.equal(first.lvl, undefined, 'invalid lvl ("bogus") must be dropped, not stored');

  const second = meta.breadcrumbs[1];
  assert.equal(second.m, 'ok');
  assert.equal(second.lvl, 'error', 'valid lvl kept');
});
